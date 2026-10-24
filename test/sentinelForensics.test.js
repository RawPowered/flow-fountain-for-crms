const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const { setPool } = require('../src/db/pool');
const { decryptSecret, encryptSecret } = require('../src/services/secretBox');
const {
  attachForensicCapture,
  redactValue,
  sanitizeHeaders,
  sanitizeUrl,
  boundedBody,
  integrityFor,
  revealForensicEvidence,
} = require('../src/services/sentinelForensics');
const { requireRootRole } = require('../src/middleware/sessionAuth');
const { waitForTelemetryIdle } = require('../src/services/telemetryWriter');

async function run() {
  const state = { count: 0 };
  const redacted = redactValue({
    password: 'plain-password',
    passwordHash: 123456,
    apiKeyId: 'key-safe-id',
    firstName: 'Alice',
    email: 'alice@example.com',
    nested: {
      note: 'Call alice@example.com with Bearer abc.def.ghi',
      source: 'def run(inputs, context):\n    return inputs',
    },
  }, '', state);
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redacted.passwordHash, '[REDACTED]');
  assert.equal(redacted.apiKeyId, 'key-safe-id');
  assert.equal(redacted.nested.source, '[GOVERNED SOURCE OMITTED]');
  assert.match(redacted.firstName, /REDACTED/);
  assert.equal(redacted.email, '[EMAIL at example.com]');
  assert.doesNotMatch(JSON.stringify(redacted), /plain-password|alice@example.com|abc\.def\.ghi/);
  assert.ok(state.count >= 4);

  const headers = sanitizeHeaders({
    authorization: 'Bearer top-secret',
    cookie: 'sid=secret-cookie',
    referer: 'https://example.test/path?email=alice@example.com&locationId=loc-1#fragment',
    'x-request-id': 'request-1',
  });
  assert.equal(headers.authorization, '[REDACTED]');
  assert.equal(headers.cookie, '[REDACTED]');
  assert.doesNotMatch(headers.referer, /alice@example.com|fragment/);
  assert.match(headers.referer, /locationId=loc-1/);
  assert.equal(sanitizeUrl('/api/leads?phone=8135551212&locationId=loc-1'), '/api/leads?phone=%5BPHONE+ending+1212%5D&locationId=loc-1');
  const oversized = boundedBody({ password: 'must-not-serialize' }, 'application/json', 2000, 1024, { count: 0 });
  assert.equal(oversized.truncated, true);
  assert.doesNotMatch(oversized.value, /must-not-serialize/);
  const binary = boundedBody(Buffer.from('binary-secret'), 'application/octet-stream', 13, 1024, { count: 0 });
  assert.match(binary.value, /OMITTED/);

  await captureIntegration();
  await revealIntegration();
  assertRootOnly();
  setPool(null);
  console.log('Sentinel forensic evidence tests passed');
}

async function captureIntegration() {
  const writes = [];
  setPool({
    async query(sql, params) {
      writes.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    attachForensicCapture(req, res, '11111111-1111-4111-8111-111111111111');
    next();
  });
  app.post('/probe', (req, res) => {
    res.setHeader('Set-Cookie', 'upstream=do-not-store');
    res.json({ ok: true, email: 'response@example.com', token: 'response-secret', diagnostic: 'useful' });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/probe?locationId=loc-1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer request-secret',
        Cookie: 'sid=request-cookie',
      },
      body: JSON.stringify({ apiKeyId: 'key-1', firstName: 'Alice', phone: '8135551212', password: 'request-password' }),
    });
    assert.equal(response.status, 200);
    await response.text();
    await waitForTelemetryIdle();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const write = writes.find((item) => item.sql.includes('INSERT INTO sentinel_http_envelopes'));
  assert.ok(write, 'encrypted evidence write expected');
  const serializedWrite = JSON.stringify(write.params);
  assert.doesNotMatch(serializedWrite, /request-secret|request-cookie|request-password|response-secret|Alice|8135551212/);
  const plaintext = decryptSecret(write.params[1]);
  assert.equal(write.params[2], integrityFor(write.params[0], plaintext));
  const evidence = JSON.parse(plaintext);
  assert.equal(evidence.request.headers.authorization, '[REDACTED]');
  assert.equal(evidence.request.headers.cookie, '[REDACTED]');
  assert.equal(evidence.request.payload.apiKeyId, 'key-1');
  assert.equal(evidence.request.payload.password, '[REDACTED]');
  assert.equal(evidence.response.headers['set-cookie'], '[REDACTED]');
  assert.equal(evidence.response.payload.token, '[REDACTED]');
  assert.equal(evidence.response.payload.diagnostic, 'useful');
}

async function revealIntegration() {
  const requestId = '22222222-2222-4222-8222-222222222222';
  const plaintext = JSON.stringify({ request: { headers: { authorization: '[REDACTED]' } }, response: { status: 401 } });
  const accessWrites = [];
  setPool({
    async query(sql, params) {
      if (sql.includes('FROM api_sentinel_events e')) {
        return [[{
          event_id: 7, request_id: requestId, created_at: new Date(), surface: 'api', action: 'api.read',
          path: '/api/probe', method: 'GET', status_code: 401, ip: '203.0.113.7',
          envelope_enc: encryptSecret(plaintext), integrity_hmac: integrityFor(requestId, plaintext),
          capture_reason: 'error_response', captured_at: new Date(), expires_at: new Date(Date.now() + 60000),
        }]];
      }
      if (sql.includes('INSERT INTO sentinel_forensic_access')) accessWrites.push(params);
      return [{ affectedRows: 1 }];
    },
  });
  const result = await revealForensicEvidence({
    eventId: 7,
    admin: { id: 'root-1', username: 'owner' },
    reason: 'Investigate repeated authorization failures',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
  });
  assert.equal(result.integrity.verified, true);
  assert.equal(result.evidence.response.status, 401);
  assert.equal(accessWrites.length, 1);
  assert.equal(accessWrites[0][8], 1);
  assert.equal(accessWrites[0][9], 'revealed');

  setPool({
    async query(sql, params) {
      if (sql.includes('FROM api_sentinel_events e')) {
        return [[{
          event_id: 8, request_id: requestId, envelope_enc: encryptSecret(plaintext),
          integrity_hmac: '0'.repeat(64),
        }]];
      }
      if (sql.includes('INSERT INTO sentinel_forensic_access')) accessWrites.push(params);
      return [{ affectedRows: 1 }];
    },
  });
  await assert.rejects(
    revealForensicEvidence({ eventId: 8, admin: { id: 'root-1' }, reason: 'Validate suspected evidence tampering' }),
    (error) => error.status === 409 && error.code === 'EVIDENCE_INTEGRITY_FAILURE'
  );
  assert.equal(accessWrites.at(-1)[9], 'integrity_failure');
}

function assertRootOnly() {
  const invoke = (admin) => {
    const result = { next: false, status: null };
    requireRootRole({ session: { admin } }, {
      status(code) { result.status = code; return this; },
      json() { return result; },
    }, () => { result.next = true; });
    return result;
  };
  assert.equal(invoke({ principalType: 'root' }).next, true);
  assert.equal(invoke({ principalType: 'platform' }).status, 403);
  assert.equal(invoke({ principalType: 'tenant' }).status, 403);
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
