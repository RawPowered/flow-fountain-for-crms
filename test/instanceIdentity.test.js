const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const {
  generateInstanceIdentity,
  validateIdentity,
  identityFromEnv,
  identityEnv,
  getInstanceIdentity,
  instanceAction,
  schemaUrn,
  outboundUserAgent,
} = require('../src/instanceIdentity');
const { generateSecret } = require('../src/services/apiKeys');
const { materializeInstanceData } = require('../src/routes/instanceData');
const { dynamicMount } = require('../src/app');
const { getActionTypes, buildImportSchema } = require('../src/services/hawk');
const { createInstallGuard } = require('../src/middleware/installGuard');

const IDENTITY_ENV_KEYS = [
  'INSTANCE_ID', 'PUBLIC_API_BASE_PATH', 'WEBHOOK_BASE_PATH', 'HEALTH_PATH',
  'API_KEY_PREFIX', 'AUTOMATION_NAMESPACE', 'SESSION_COOKIE_NAME',
  'OPERATOR_COOKIE_NAME', 'API_DISPLAY_NAME', 'API_METADATA_HEADERS_ENABLED',
  'API_METADATA_HEADER_PREFIX',
];

function configuredIdentity(overrides = {}) {
  return generateInstanceIdentity({
    instanceId: 'd91de3d6-e11f-4c9a-8e21-9d630a9c2671',
    publicApiBasePath: '/suite42/api',
    webhookBasePath: '/suite42/hooks',
    healthPath: '/suite42/status',
    apiKeyPrefix: 'q42_',
    automationNamespace: 'suite42',
    sessionCookieName: 'c_suite42',
    operatorCookieName: 'o_suite42',
    apiDisplayName: 'Store Connector',
    metadataHeadersEnabled: false,
    metadataHeaderPrefix: 'Suite42',
    ...overrides,
  });
}

function invokeGuard(guard, requestPath, headers = {}) {
  let result = null;
  const response = {
    status(code) { this.statusCode = code; return this; },
    json(body) { result = { status: this.statusCode || 200, body }; return this; },
    send(body) { result = { status: this.statusCode || 200, body }; return this; },
  };
  guard({ path: requestPath, headers }, response, () => { result = { next: true }; });
  return result;
}

async function run() {
  const root = path.join(__dirname, '..');
  const activeHtaccess = fs.readFileSync(path.join(root, '.htaccess'), 'utf8');
  const htaccessTemplate = fs.readFileSync(path.join(root, '.htaccess.example'), 'utf8');
  assert.doesNotMatch(activeHtaccess, /PassengerAppRoot|SetEnv\s+\w+\s+\S+/);
  assert.match(htaccessTemplate, /INSTANCE_ABSOLUTE_APP_ROOT/);
  assert.doesNotMatch(htaccessTemplate, /SetEnv\s+\w+\s+\S+/);

  const first = generateInstanceIdentity();
  const second = generateInstanceIdentity();
  for (const property of [
    'instanceId', 'publicApiBasePath', 'webhookBasePath', 'healthPath',
    'apiKeyPrefix', 'automationNamespace', 'sessionCookieName',
    'operatorCookieName', 'metadataHeaderPrefix',
  ]) {
    assert.notEqual(first[property], second[property], `${property} must vary by installation`);
  }

  const custom = configuredIdentity();
  assert.deepEqual(identityFromEnv(identityEnv(custom), { allowDevelopmentDefaults: false }), custom);
  assert.throws(
    () => generateInstanceIdentity({ publicApiBasePath: '/api/secret' }),
    /reserved path segment/
  );
  assert.throws(
    () => configuredIdentity({ webhookBasePath: '/suite42/api' }),
    /must be different/
  );
  assert.throws(
    () => validateIdentity({ ...custom, apiKeyPrefix: 'x' }),
    /3-16/
  );

  const previous = Object.fromEntries(IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, identityEnv(custom));
  try {
    assert.deepEqual(getInstanceIdentity(), custom);
    assert.match(generateSecret(), /^q42_[A-Za-z0-9_-]+$/);
    assert.equal(instanceAction('assign_dialer'), 'suite42.assign_dialer');
    assert.ok(getActionTypes().includes('suite42.assign_dialer'));
    assert.ok(getActionTypes().includes('suite42.apply_call_outcome'));
    assert.match(outboundUserAgent('compliance'), /^[a-f0-9]{16}\.compliance\/1\.0$/);
    assert.doesNotMatch(outboundUserAgent('compliance'), /workbench|workbench/i);
    assert.equal(
      schemaUrn('hawk-automation-import'),
      'urn:instance:d91de3d6-e11f-4c9a-8e21-9d630a9c2671:schema:hawk-automation-import'
    );
    assert.equal(buildImportSchema({ fields: [], objects: [] }).$id, schemaUrn('hawk-automation-import'));

    const installGuard = createInstallGuard(() => ({ installed: false }));
    assert.deepEqual(invokeGuard(installGuard, '/suite42/api/leads'), {
      status: 503,
      body: { error: 'Service unavailable' },
    });
    assert.equal(invokeGuard(installGuard, '/api/leads').status, 404);
    assert.deepEqual(invokeGuard(installGuard, '/suite42/status'), { next: true });

    const source = JSON.stringify({
      name: 'Workbench integration',
      endpoint: 'https://api.example.invalid/api/leads',
      webhook: '/hooks/hawk/example',
      action: 'workbench.assign_dialer',
      keyExample: 'sp_live_example',
      $id: 'https://api.example.invalid/schemas/hawk-automation-import.schema.json',
    });
    const materialized = materializeInstanceData(source, {
      protocol: 'https',
      get: (name) => name === 'host' ? 'store.example' : '',
    }, 'hawk-automation-import.schema.json');
    const parsed = JSON.parse(materialized);
    assert.equal(parsed.name, 'Store Connector integration');
    assert.equal(parsed.endpoint, 'https://store.example/suite42/api/leads');
    assert.equal(parsed.webhook, '/suite42/hooks/hawk/example');
    assert.equal(parsed.action, 'suite42.assign_dialer');
    assert.equal(parsed.keyExample, 'q42_example');
    assert.equal(parsed.$id, schemaUrn('hawk-automation-import'));
    assert.doesNotMatch(materialized, /workbench|sp_live_/i);

    const app = express();
    const mounted = express.Router();
    mounted.get('/ping', (req, res) => res.json({ path: req.path, originalUrl: req.originalUrl }));
    app.use(dynamicMount(() => getInstanceIdentity().publicApiBasePath, mounted));
    app.use((req, res) => res.sendStatus(404));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${base}/suite42/api/ping?probe=1`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        path: '/ping',
        originalUrl: '/suite42/api/ping?probe=1',
      });
      assert.equal((await fetch(`${base}/api/ping`)).status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    for (const key of IDENTITY_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }

  console.log('Instance identity tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
