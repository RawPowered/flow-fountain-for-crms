const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const { setPool } = require('../src/db/pool');
const {
  controlPlaneSentinel,
  classifyControlRequest,
  surfaceFor,
  safeId,
} = require('../src/middleware/controlPlaneSentinel');
const { apiContext } = require('../src/middleware/apiSentinel');
const { waitForTelemetryIdle } = require('../src/services/telemetryWriter');

async function run() {
  assert.deepEqual(
    classifyControlRequest('POST', '/api/song/scripts/script-123/publish'),
    {
      surface:'song', path:'/api/song/scripts/:id/publish', action:'song.script.publish',
      entityType:'song_script', entityId:'script-123',
    }
  );
  assert.equal(classifyControlRequest('GET', '/api/eagle/export.csv').action, 'eagle.leads.export');
  assert.deepEqual(
    classifyControlRequest('POST', '/api/eagle/debug/schedules/user-123/reset'),
    { surface:'eagle', path:'/api/eagle/debug/schedules/:id/reset', action:'eagle.schedule.reset', entityType:'schedule', entityId:'user-123' }
  );
  assert.equal(classifyControlRequest('POST', '/api/owl/leads/assign').action, 'owl.leads.assign');
  assert.equal(classifyControlRequest('POST', '/api/owl/dnc-screening/scrub').action, 'owl.dnc.api.batch_scrub');
  assert.equal(classifyControlRequest('POST', '/api/owl/dnc-review-rescrub').action, 'owl.dnc.api.review_rescrub');
  assert.equal(classifyControlRequest('POST', '/api/owl/dnc-review-release').action, 'owl.dnc.review.release');
  assert.equal(classifyControlRequest('POST', '/api/owl/dnc-rescrub').action, 'owl.dnc.api.pool_rescrub');
  assert.equal(classifyControlRequest('POST', '/api/owl/no-phone/refresh').action, 'owl.channels.no_phone_refresh');
  assert.equal(classifyControlRequest('POST', '/api/owl/service-pools/recheck').action, 'owl.service_pool.recheck');
  assert.equal(classifyControlRequest('POST', '/api/hawk/catalog/refresh').action, 'hawk.catalog.refresh');
  assert.equal(classifyControlRequest('POST', '/api/hawk/imports/apply').action, 'hawk.import.apply');
  assert.equal(classifyControlRequest('POST', '/api/parrot/imports/apply').action, 'parrot.import.apply');
  assert.equal(classifyControlRequest('GET', '/api/parrot/scripts/script-123/export').action, 'parrot.script.export');
  assert.deepEqual(
    classifyControlRequest('POST', '/api/owl/dnc-screening/lead-123/scrub'),
    {
      surface:'owl', path:'/api/owl/dnc-screening/:id/scrub', action:'owl.dnc.api.lead_scrub',
      entityType:'lead', entityId:'lead-123',
    }
  );
  assert.deepEqual(
    classifyControlRequest('PATCH', '/api/owl/users/user-123/password'),
    {
      surface:'owl', path:'/api/owl/users/:id/password', action:'owl.user.password_change',
      entityType:'user', entityId:'user-123',
    }
  );
  assert.equal(surfaceFor('/api/owl/compliance'), 'owl');
  assert.equal(safeId('contact_123', 191), 'contact_123');
  assert.equal(safeId('unsafe value with spaces', 191), null);
  assert.equal(apiContext('GET', '/api/song/runtime').action, 'song.runtime.read');
  assert.equal(apiContext('POST', '/api/song/events').action, 'song.runtime.event');

  const writes = [];
  setPool({
    async query(sql, params) {
      if (sql.includes('INSERT INTO api_sentinel_events')) writes.push({ sql, params });
      return [{ affectedRows:1 }];
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/p/secret-value', (req, res, next) => {
    req.session = { admin:{
      id:'admin-1', username:'root-admin', principalType:'root', apiKeyId:null,
    } };
    next();
  }, controlPlaneSentinel);
  app.post('/p/secret-value/api/song/scripts/:id/publish', (req, res) => res.json({ ok:true }));
  app.get('/p/secret-value/api/eagle/export.csv', (req, res) => res.type('text/csv').send('safe'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/p/secret-value`;
    const response = await fetch(`${base}/api/song/scripts/script-123/publish`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({
        apiKeyId:'key-1', locationId:'location-1',
        graph:{ prompt:'PRIVATE SCRIPT PROMPT' }, credential:'DO NOT LOG',
      }),
    });
    assert.equal(response.status, 200);
    const exportResponse = await fetch(`${base}/api/eagle/export.csv?locationId=location-1`);
    assert.equal(exportResponse.status, 200);
    await waitForTelemetryIdle();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setPool(null);
  }

  const eventWrites = writes.filter((entry) => entry.sql.includes('api_sentinel_events')).flatMap((entry) => entry.params[0].map((params) => ({sql: entry.sql, params})));
  assert.equal(eventWrites.length, 2);
  const publish = eventWrites.find((entry) => entry.params[15] === 'song.script.publish');
  assert.ok(publish);
  assert.equal(publish.params[0], 'key-1');
  assert.equal(publish.params[3], '/api/song/scripts/:id/publish');
  assert.equal(publish.params[8], 'location-1');
  assert.equal(publish.params[11], 'song');
  assert.equal(publish.params[12], 'root');
  assert.equal(publish.params[13], 'admin-1');
  assert.equal(publish.params[14], 'root-admin');
  assert.equal(publish.params[16], 'song_script');
  assert.equal(publish.params[17], 'script-123');
  assert.equal(publish.params[18], 'success');
  const serialized = JSON.stringify(eventWrites);
  assert.doesNotMatch(serialized, /secret-value|PRIVATE SCRIPT PROMPT|DO NOT LOG/);
  assert.ok(eventWrites.some((entry) => entry.params[15] === 'eagle.leads.export'));

  console.log('Control-plane Sentinel tests passed');
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
