const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const { setPool } = require('../src/db/pool');
const { tokenHash } = require('../src/services/operatorSessions');
const { createSessionsRouter } = require('../src/routes/api/sessions');

async function run() {
  const token = 'A'.repeat(43);
  const fakePool = {
    query:async (sql, params = []) => {
      if (sql.includes('FROM api_operator_sessions s')) {
        if (params[0] !== tokenHash(token)) return [[]];
        return [[{
          apiKeyId:'key-1', userId:'user-1', locationId:'location-1', isAdmin:0,
          expiresAt:'2099-07-13 12:00:00.000', username:'operator', crmUserName:'Operator',
        }]];
      }
      if (sql.startsWith('UPDATE api_operator_sessions SET last_used_at')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected Phase 1 route query: ${sql}`);
    },
  };
  setPool(fakePool);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.apiKey = { id:'key-1' }; next(); });
  app.use('/api/sessions', createSessionsRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/sessions/workspace`;
    const anonymous = await fetch(`${base}?locationId=location-1&userId=user-1`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, 'OPERATOR_SESSION_REQUIRED');

    const mismatched = await fetch(`${base}?locationId=location-1&userId=user-2`, {
      headers:{ 'X-Operator-Token':token },
    });
    assert.equal(mismatched.status, 403);
    assert.equal((await mismatched.json()).code, 'OPERATOR_USER_MISMATCH');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setPool(null);
  }
  console.log('Phase 1 route authority tests passed');
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
