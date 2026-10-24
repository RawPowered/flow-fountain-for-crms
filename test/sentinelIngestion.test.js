const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const { setPool } = require('../src/db/pool');
const { apiSentinel } = require('../src/middleware/apiSentinel');
const { recordLoginEvent } = require('../src/services/loginSecurity');
const {
  enqueueTelemetry,
  waitForTelemetryIdle,
  resetTelemetryWriterStatus,
} = require('../src/services/telemetryWriter');
const { telemetryWriterCheck, verifyTelemetryWritePath } = require('../src/services/sentinelHealth');

async function run() {
  await retryAndFailureAccounting();
  await apiAndLoginIngestion();
  await transactionalProbe();
  setPool(null);
  console.log('Sentinel ingestion assurance tests passed');
}

async function retryAndFailureAccounting() {
  resetTelemetryWriterStatus();
  let attempts = 0;
  const recovered = await enqueueTelemetry('retry_probe', async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('transient'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
  }, { retryBaseMs: 1, maxAttempts: 4 });
  assert.equal(recovered, true);
  let status = await waitForTelemetryIdle();
  assert.equal(status.writers.retry_probe.written, 1);
  assert.equal(status.writers.retry_probe.retries, 2);
  assert.equal(telemetryWriterCheck(status).status, 'healthy');

  const failed = await enqueueTelemetry('failure_probe', async () => {
    throw Object.assign(new Error('permanent'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
  }, { retryBaseMs: 1, maxAttempts: 2 });
  assert.equal(failed, false);
  status = await waitForTelemetryIdle();
  assert.equal(status.writers.failure_probe.failed, 1);
  assert.equal(status.writers.failure_probe.lastErrorCode, 'ER_TABLEACCESS_DENIED_ERROR');
  assert.equal(telemetryWriterCheck(status).status, 'critical');
}

async function apiAndLoginIngestion() {
  resetTelemetryWriterStatus();
  const writes = [];
  setPool({
    async query(sql, params) {
      writes.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api', apiSentinel);
  app.get('/api/system/status', (req, res) => res.json({ success: true, authenticated: false }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/system/status`);
    assert.equal(response.status, 200);
    const requestId = response.headers.get('x-request-id');
    assert.match(requestId, /^[a-f0-9-]{36}$/i);
    await recordLoginEvent({
      event_type: 'login', outcome: 'failure', detail: 'invalid_credentials', request_id: requestId,
    });
    await waitForTelemetryIdle();
    const apiWrite = writes.find((entry) => entry.sql.includes('INSERT INTO api_sentinel_events'));
    const loginWrite = writes.find((entry) => entry.sql.includes('INSERT INTO api_login_events'));
    assert.ok(apiWrite, 'API event must be persisted');
    assert.ok(loginWrite, 'login event must be persisted');
    const apiRow = apiWrite.params[0][0];
    assert.equal(apiRow[10], requestId);
    assert.equal(apiRow[11], 'sentinel');
    assert.equal(apiRow[15], 'sentinel.auth.read');
    assert.equal(loginWrite.params[11], requestId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function transactionalProbe() {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async query(sql) { calls.push(sql.includes('api_login_events') ? 'login' : 'api'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
  };
  const result = await verifyTelemetryWritePath({ async getConnection() { return connection; } });
  assert.equal(result.status, 'healthy');
  assert.deepEqual(calls, ['begin', 'api', 'login', 'rollback', 'release']);

  const denied = await verifyTelemetryWritePath({
    async getConnection() {
      return {
        async beginTransaction() {},
        async query() { throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }); },
        async rollback() {},
        release() {},
      };
    },
  });
  assert.equal(denied.status, 'critical');
  assert.equal(denied.metrics.code, 'ER_TABLEACCESS_DENIED_ERROR');
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
