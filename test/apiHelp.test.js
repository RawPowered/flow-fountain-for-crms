const assert = require('assert/strict');
const http = require('http');
const express = require('express');
Object.assign(process.env, {
  INSTANCE_ID: 'd91de3d6-e11f-4c9a-8e21-9d630a9c2671',
  PUBLIC_API_BASE_PATH: '/suite42/api',
  WEBHOOK_BASE_PATH: '/suite42/hooks',
  HEALTH_PATH: '/suite42/status',
  API_KEY_PREFIX: 'q42_',
  AUTOMATION_NAMESPACE: 'suite42',
  SESSION_COOKIE_NAME: 'c_suite42',
  OPERATOR_COOKIE_NAME: 'o_suite42',
  API_DISPLAY_NAME: 'Store Connector',
  API_METADATA_HEADERS_ENABLED: 'true',
  API_METADATA_HEADER_PREFIX: 'Suite42',
});
const API_BASE = process.env.PUBLIC_API_BASE_PATH;
const { COMMANDS, getCommand } = require('../src/services/apiHelp');
const { SCHEMA_VERSION } = require('../src/config');
const {
  createApiHelpRouter,
  validateRequest,
  buildOpenApi,
} = require('../src/routes/api/help');

async function run() {
  assert.ok(COMMANDS.length >= 40);
  const assigned = getCommand('leads.assigned');
  assert.equal(assigned.method, 'GET');
  assert.equal(assigned.path, `${API_BASE}/leads/assigned`);
  assert.match(assigned.access, /read grant/);

  const invalid = validateRequest(assigned, { query: { locationId: 'location-1' } });
  assert.ok(invalid.missing.includes('headers.X-Operator-Token'));
  assert.ok(invalid.missing.includes('query.userId'));
  const valid = validateRequest(assigned, {
    headers: { 'X-Operator-Token':'operator-token' },
    query: { locationId: 'location-1', userId: 'user-1' },
  });
  assert.deepEqual(valid.missing, []);

  const login = getCommand('users.login');
  const loginValidation = validateRequest(login, {
    body: { locationId: 'location-1', userId: 'user-1' },
  });
  assert.ok(loginValidation.missing.some((item) => item.includes('password')));

  const openapi = buildOpenApi('https://store.example');
  assert.equal(openapi.openapi, '3.1.0');
  assert.equal(openapi.info.title, 'Store Connector');
  assert.doesNotMatch(JSON.stringify(openapi), /workbench|sp_live_/i);
  assert.equal(openapi.paths[`${API_BASE}/leads/assigned`].get.operationId, 'leads.assigned');
  assert.equal(openapi.paths[`${API_BASE}/leads/call-attempts/authorize`].post.operationId, 'leads.callAuthorizeContact');
  assert.equal(openapi.paths[`${API_BASE}/song/scripts`].get.operationId, 'song.scripts');
  assert.equal(openapi.paths[`${API_BASE}/users/{userId}/schedule/submit`].post.operationId, 'schedules.submit');
  assert.equal(openapi.paths[`${API_BASE}/users/{userId}/work-sessions/start`].post.operationId, 'workSessions.start');
  assert.equal(openapi.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.equal(openapi.components.securitySchemes.operatorToken.name, 'X-Operator-Token');
  assert.ok(openapi.paths[`${API_BASE}/leads/assigned`].get.parameters.some(
    (parameter) => parameter.in === 'header' && parameter.name === 'X-Operator-Token' && parameter.required
  ));

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.apiKey = { id: 'key-1' }; next(); });
  app.use(`${API_BASE}/help`, createApiHelpRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const textResponse = await fetch(`${base}${API_BASE}/help?format=text`);
    assert.equal(textResponse.status, 200);
    assert.equal(textResponse.headers.get('cache-control'), 'no-store');
    assert.equal(textResponse.headers.get('x-suite42-schema-version'), String(SCHEMA_VERSION));
    assert.equal(textResponse.headers.get('x-workbench-schema-version'), null);
    const text = await textResponse.text();
    assert.match(text, /leads\.assigned/);
    assert.match(text, /calendars\.resolve/);
    assert.match(text, /Authorization: Bearer/);

    const detailResponse = await fetch(`${base}${API_BASE}/help/leads.assigned`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.deepEqual(detail.command.required.query, ['locationId', 'userId']);
    assert.deepEqual(detail.command.required.headers, ['X-Operator-Token']);
    assert.match(detail.command.access, /read grant/);
    assert.match(detail.request.curl, /X-Operator-Token/);

    const validateResponse = await fetch(`${base}${API_BASE}/help/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'leads.assigned',
        headers: { 'X-Operator-Token':'operator-token' },
        query: { locationId: 'location-1', userId: 'user-1' },
      }),
    });
    const validation = await validateResponse.json();
    assert.equal(validation.valid, true);
    assert.match(validation.request.url, /locationId=location-1&userId=user-1/);

    const sqlValidationResponse = await fetch(`${base}${API_BASE}/help/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'sql.row.insert',
        path: { slug: 'reporting-db', table: 'customers' },
        body: {},
      }),
    });
    const sqlValidation = await sqlValidationResponse.json();
    assert.equal(sqlValidation.valid, false);
    assert.ok(sqlValidation.missing.includes('body: non-empty JSON object'));

    const specResponse = await fetch(`${base}${API_BASE}/help/openapi.json`);
    assert.equal(specResponse.status, 200);
    const spec = await specResponse.json();
    assert.equal(spec.paths[`${API_BASE}/proxy`], undefined);
    assert.equal(spec.paths[`${API_BASE}/song/runtime`].get.operationId, 'song.runtime');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('API help tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
