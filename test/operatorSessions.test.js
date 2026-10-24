const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const { setPool } = require('../src/db/pool');
const {
  createOperatorSession,
  verifyOperatorSession,
  tokenHash,
  requireOperatorSession,
  OPERATOR_COOKIE_NAME,
} = require('../src/services/operatorSessions');
const { createSystemIdentityRouter } = require('../src/routes/api/systemIdentity');
const { sanitizeApiResponse } = require('../src/middleware/responseSanitizer');

async function run() {
  let storedHash = null;
  let revoked = false;
  const queries = [];
  const fakePool = {
    query:async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.startsWith('INSERT INTO api_operator_sessions')) {
        storedHash = params[0];
        assert.match(storedHash, /^[a-f0-9]{64}$/);
        assert.equal(params[4], 1);
        return [{ affectedRows:1 }];
      }
      if (sql.includes('FROM api_operator_sessions s')) {
        if (params[0] !== storedHash || revoked) return [[]];
        return [[{
          apiKeyId:'key-1', userId:'user-1', locationId:'location-1', isAdmin:1,
          expiresAt:'2026-07-12 18:30:00.000', username:'gato', crmUserName:'Joseph Edwards',
        }]];
      }
      if (sql.startsWith('UPDATE api_operator_sessions SET last_used_at')) return [{ affectedRows:1 }];
      if (sql.startsWith('UPDATE api_operator_sessions SET revoked_at')) {
        if (params[0] === storedHash) revoked = true;
        return [{ affectedRows:params[0] === storedHash ? 1 : 0 }];
      }
      throw new Error(`Unexpected operator-session query: ${sql}`);
    },
  };

  const issued = await createOperatorSession({
    apiKeyId:'key-1',
    user:{ id:'user-1', locationId:'location-1', username:'gato', role:'admin' },
  }, fakePool);
  assert.equal(issued.scheme, 'Operator');
  assert.equal(issued.headerName, 'X-Operator-Token');
  assert.match(issued.token, /^[A-Za-z0-9_-]{40,128}$/);
  assert.equal(storedHash, tokenHash(issued.token));
  assert.notEqual(storedHash, issued.token);
  const verified = await verifyOperatorSession(issued.token, fakePool);
  assert.equal(verified.isAdmin, true);
  assert.equal(verified.displayName, 'Joseph Edwards');
  assert.equal(Object.prototype.hasOwnProperty.call(verified, 'role'), false);
  const bound = await requireOperatorSession({
    apiKey:{ id:'key-1' },
    get:(name) => name.toLowerCase() === 'x-operator-token' ? issued.token : '',
  }, { locationId:'location-1', userId:'user-1' }, fakePool);
  assert.equal(bound.userId, 'user-1');
  const cookieBound = await requireOperatorSession({
    apiKey:{ id:'key-1' },
    cookies:{ [OPERATOR_COOKIE_NAME]:issued.token },
    get:() => '',
  }, { locationId:'location-1', userId:'user-1' }, fakePool);
  assert.equal(cookieBound.userId, 'user-1');
  await assert.rejects(
    requireOperatorSession({
      apiKey:{ id:'key-1' },
      get:(name) => name.toLowerCase() === 'x-operator-token' ? issued.token : '',
    }, { locationId:'location-1', userId:'user-2' }, fakePool),
    (error) => error.status === 403 && error.code === 'OPERATOR_USER_MISMATCH'
  );

  const sanitized = sanitizeApiResponse({
    success:true,
    user:{ id:'user-1', role:'admin', passwordHash:'bcrypt', nested:{ password_hash:'legacy' } },
    rows:[{ credential_enc:'encrypted', token_hash:'hash', safe:'value' }],
    session:{ token:issued.token },
  });
  assert.equal(sanitized.user.passwordHash, undefined);
  assert.equal(sanitized.user.nested.password_hash, undefined);
  assert.equal(sanitized.rows[0].credential_enc, undefined);
  assert.equal(sanitized.rows[0].safe, 'value');
  assert.equal(sanitized.session.token, issued.token);

  setPool(fakePool);
  const app = express();
  app.use(express.json());
  app.use('/api/system', createSystemIdentityRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/system`;
    const anonymousResponse = await fetch(`${base}/has-admin`);
    assert.equal(anonymousResponse.status, 200);
    assert.deepEqual(await anonymousResponse.json(), { success:true, authenticated:false, hasAdmin:false });
    assert.match(anonymousResponse.headers.get('cache-control'), /no-store/);

    const statusResponse = await fetch(`${base}/status`, {
      headers:{ Authorization:`Operator ${issued.token}` },
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.authenticated, true);
    assert.equal(status.user.displayName, 'Joseph Edwards');
    assert.equal(Object.prototype.hasOwnProperty.call(status.user, 'role'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(status.user, 'email'), false);

    const adminResponse = await fetch(`${base}/has-admin`, {
      headers:{ 'X-Operator-Token':issued.token },
    });
    assert.deepEqual(await adminResponse.json(), { success:true, authenticated:true, hasAdmin:true });

    const cookieResponse = await fetch(`${base}/status`, {
      headers:{ Cookie:`${OPERATOR_COOKIE_NAME}=${issued.token}` },
    });
    assert.equal(cookieResponse.status, 200);
    assert.equal((await cookieResponse.json()).authenticated, true);

    const invalidResponse = await fetch(`${base}/status`, {
      headers:{ Authorization:`Operator ${'A'.repeat(43)}` },
    });
    assert.equal(invalidResponse.status, 401);

    const logoutResponse = await fetch(`${base}/logout`, {
      method:'POST', headers:{ Authorization:`Operator ${issued.token}` },
    });
    assert.equal(logoutResponse.status, 200);
    assert.match(logoutResponse.headers.get('set-cookie') || '', new RegExp(`^${OPERATOR_COOKIE_NAME}=`));
    const revokedResponse = await fetch(`${base}/status`, {
      headers:{ Authorization:`Operator ${issued.token}` },
    });
    assert.equal(revokedResponse.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setPool(null);
  }

  assert.ok(queries.some((entry) => entry.sql.includes('last_used_at=UTC_TIMESTAMP')));
  console.log('Operator session tests passed');
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
