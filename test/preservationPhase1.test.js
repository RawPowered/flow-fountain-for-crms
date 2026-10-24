const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const integration = require('../src/services/integrationManagement');
const preservation = require('../src/services/preservation');
const { sanitizeAuditDetails } = require('../src/services/preservationAudit');
const { createAdminPreservationRouter } = require('../src/routes/adminPreservation');
const {
  classifyControlRequest,
  surfaceFor,
} = require('../src/middleware/controlPlaneSentinel');
const {
  preservationCapabilities,
  hasPreservationCapability,
} = require('../src/middleware/preservationAccess');
const { SCHEMA_VERSION } = require('../src/config');

async function testCredentialVault() {
  const previousKey = process.env.SECRET_BOX_KEY;
  process.env.SECRET_BOX_KEY = 'preservation-phase-1-test-key-material';
  const rows = new Map();
  const writes = [];
  const pool = {
    async query(sql, params = []) {
      writes.push({ sql, params });
      if (sql.includes('INSERT INTO integration_secrets')) {
        rows.set(params[0], {
          id: params[0],
          name: params[1],
          secret_kind: params[2],
          secret_enc: params[3],
          secret_hint: params[4],
          version_number: 1,
          status: 'active',
          created_by: params[5],
          created_at: new Date(),
          updated_at: new Date(),
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO preservation_audit_events')) return [{ affectedRows: 1 }];
      if (sql.includes('SELECT * FROM integration_secrets WHERE id')) {
        return [[rows.get(params[0])].filter(Boolean)];
      }
      throw new Error(`Unexpected vault query: ${sql}`);
    },
  };
  try {
    const publicValue = await integration.createSecret({
      name: 'Archive token',
      kind: 'bearer_token',
      secret: 'super-secret-token',
    }, { actorId: 'root-1', actorType: 'root' }, pool);
    assert.equal(publicValue.hasSecret, true);
    assert.equal(publicValue.hint, 'oken');
    assert.equal(Object.hasOwn(publicValue, 'secret'), false);
    assert.equal(Object.hasOwn(publicValue, 'secret_enc'), false);
    const stored = [...rows.values()][0];
    assert.notEqual(stored.secret_enc, 'super-secret-token');
    assert.equal(stored.secret_enc.includes('super-secret-token'), false);
    const resolved = await integration.resolveSecret(stored.id, pool);
    assert.equal(resolved.value, 'super-secret-token');
    assert.equal(
      writes.some((item) => item.sql.includes('preservation_audit_events')),
      true,
      'Vault mutations must create preservation audit evidence'
    );
  } finally {
    if (previousKey === undefined) delete process.env.SECRET_BOX_KEY;
    else process.env.SECRET_BOX_KEY = previousKey;
  }
}

async function testRouteAuthority() {
  async function requestAs(admin, pathname, options = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.session = admin ? { admin } : {};
      next();
    });
    app.use(createAdminPreservationRouter());
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      return await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, options);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const anonymous = await requestAs(null, '/api/preservation/bootstrap', {
    headers: { Accept: 'application/json' },
  });
  assert.equal(anonymous.status, 401);

  const platformSecretWrite = await requestAs(
    { id: 'platform-1', principalType: 'platform' },
    '/api/preservation/secrets',
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope', kind: 'api_key', secret: 'blocked' }),
    }
  );
  assert.equal(platformSecretWrite.status, 403);
  assert.match((await platformSecretWrite.json()).error, /manage_secrets/);
}

function testDefinitionDsl() {
  const first = preservation.normalizeVersionPayload({
    sourceConfig: { includeCurrent: true },
    mappings: [
      { source: 'contact.id', target: 'contact_id', type: 'string', required: true },
      { source: 'contact.email', target: 'email', transform: 'lowercase' },
    ],
    filters: [{ field: 'contact.locationId', operator: 'eq', value: 'location-1' }],
    formatConfig: { delimiter: ',', includeHeader: true },
  }, 'csv');
  const second = preservation.normalizeVersionPayload({
    formatConfig: { includeHeader: true, delimiter: ',' },
    filters: [{ value: 'location-1', operator: 'eq', field: 'contact.locationId' }],
    mappings: [
      { required: true, type: 'string', target: 'contact_id', source: 'contact.id' },
      { transform: 'lowercase', target: 'email', source: 'contact.email' },
    ],
    sourceConfig: { includeCurrent: true },
  }, 'csv');
  assert.equal(first.schemaSha256, second.schemaSha256, 'Canonical definition hashes must be stable');
  assert.equal(first.mappings.length, 2);

  assert.throws(
    () => preservation.normalizeVersionPayload({
      sourceConfig: { query: 'SELECT * FROM leads' },
      mappings: [{ source: 'id', target: 'id' }],
    }, 'csv'),
    /arbitrary SQL/
  );
  assert.throws(
    () => preservation.validateMappings([
      { source: 'id', target: 'id' },
      { source: 'other', target: 'id' },
    ], 'csv'),
    /Duplicate mapping target/
  );
  assert.throws(
    () => preservation.validateMappings([{ source: 'id', target: 'unsafe-name' }], 'sql'),
    /safe identifier/
  );
  assert.throws(
    () => preservation.validateMappings([{ source: 'id', target: 'id', transform: 'javascript' }], 'csv'),
    /Unsupported declarative transform/
  );
  assert.deepEqual(preservation.JOB_TRANSITIONS.queued, ['extracting', 'cancelled']);
  assert.deepEqual(preservation.JOB_TRANSITIONS.completed, []);
}

function testConnectionSafety() {
  assert.equal(
    integration.validateHttpsUrl('https://archive.example.com/ingest'),
    'https://archive.example.com/ingest'
  );
  assert.throws(() => integration.validateHttpsUrl('http://archive.example.com'), /HTTPS/);
  assert.throws(() => integration.validateHttpsUrl('https://localhost/archive'), /blocked/);
  assert.throws(() => integration.validateHttpsUrl('https://127.0.0.1/archive'), /blocked/);
  assert.throws(() => integration.validateHttpsUrl('https://169.254.169.254/latest'), /blocked/);
  assert.throws(() => integration.validateHttpsUrl('https://user:pass@example.com'), /credentials/);
  assert.throws(
    () => integration.validatePublicConfig({ apiToken: 'must-not-be-here' }),
    /credential reference/
  );
  const local = integration.normalizeDestination({
    slug: 'local-stage',
    name: 'Local staging',
    destinationType: 'local_staging',
    config: { relativePath: 'preservation/staging' },
    isProtectionTarget: true,
  });
  assert.equal(local.isProtectionTarget, false);
  assert.throws(
    () => integration.normalizeDestination({
      slug: 'bad-stage',
      name: 'Bad staging',
      destinationType: 'local_staging',
      config: { relativePath: '../outside' },
    }),
    /remain within/
  );
}

function testSchemaAndInterface() {
  const root = path.join(__dirname, '..');
  const schema = fs.readFileSync(path.join(root, 'sql', 'schema.sql'), 'utf8');
  [
    'integration_secrets',
    'integration_registry',
    'preservation_destinations',
    'preservation_export_definitions',
    'preservation_export_versions',
    'preservation_jobs',
    'preservation_artifacts',
    'preservation_job_manifests',
    'preservation_delivery_attempts',
    'preservation_audit_events',
  ].forEach((table) => {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
  });
  assert.match(schema, /secret_enc\s+MEDIUMTEXT\s+NOT NULL/);
  assert.match(schema, /UNIQUE KEY uq_preservation_job_idempotency/);
  assert.match(schema, /protection_status\s+VARCHAR\(24\)/);
  assert.ok(Number(SCHEMA_VERSION) >= 48);

  const html = fs.readFileSync(path.join(root, 'public', 'admin', 'preservation.html'), 'utf8');
  assert.match(html, /Secret values are write-only and never returned/i);
  assert.match(html, /Phase 2 preservation worker/i);
  assert.doesNotMatch(html, /super-secret-token/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]), 'Admin interface script must parse');

  const appSource = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(appSource, /createAdminPreservationRouter/);
  const docs = fs.readFileSync(
    path.join(root, 'content', 'docs', 'preservation-control-plane.md'),
    'utf8'
  );
  assert.match(docs, /installation-defined public API prefix/);
  assert.match(docs, /does not yet extract records/i);
  assert.equal(surfaceFor('/api/preservation/jobs'), 'preservation');
  assert.deepEqual(
    classifyControlRequest('POST', '/api/preservation/jobs/job-123/cancel'),
    {
      surface: 'preservation',
      path: '/api/preservation/jobs/:id/cancel',
      action: 'preservation.job.cancel',
      entityType: 'preservation_job',
      entityId: 'job-123',
    }
  );
}

function testAuditRedaction() {
  const sanitized = sanitizeAuditDetails({
    destinationId: 'destination-1',
    credential: 'secret-value',
    nested: { apiKey: 'also-secret', count: 2 },
  });
  assert.equal(sanitized.destinationId, 'destination-1');
  assert.equal(sanitized.credential, '[redacted]');
  assert.equal(sanitized.nested.apiKey, '[redacted]');
  assert.equal(sanitized.nested.count, 2);
}

async function testProtectedCompletionGate() {
  const job = {
    id: 'job-1',
    job_type: 'export',
    definition_id: 'definition-1',
    version_id: 'version-1',
    destination_id: 'destination-1',
    idempotency_key: 'job-key-1',
    status: 'delivering',
    protection_status: 'unprotected',
    progress_percent: 80,
    queued_at: new Date(),
  };
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('SELECT * FROM preservation_jobs WHERE id=')) return [[job]];
      if (sql.includes('SELECT COUNT(*) AS total')) return [[{ total: 1, verified: 1 }]];
      if (sql.includes('COUNT(DISTINCT a.id) AS delivered')) {
        return [[{ delivered: 1, protected_deliveries: 1 }]];
      }
      if (sql.includes('UPDATE preservation_jobs SET')) {
        job.status = params[0];
        job.protection_status = params[1];
        job.progress_percent = params[2];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO preservation_audit_events')) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected completion query: ${sql}`);
    },
  };
  const completed = await preservation.transitionJob(
    job.id,
    'completed',
    {},
    { actorId: 'worker-1', actorType: 'service' },
    pool
  );
  assert.equal(completed.status, 'completed');
  assert.equal(completed.protectionStatus, 'verified_off_instance');
  assert.equal(completed.progressPercent, 100);

  const incomplete = {
    ...job,
    id: 'job-2',
    status: 'delivering',
    protection_status: 'unprotected',
  };
  const incompletePool = {
    async query(sql) {
      if (sql.includes('SELECT * FROM preservation_jobs WHERE id=')) return [[incomplete]];
      if (sql.includes('SELECT COUNT(*) AS total')) return [[{ total: 1, verified: 0 }]];
      throw new Error(`Unexpected incomplete query: ${sql}`);
    },
  };
  await assert.rejects(
    preservation.transitionJob(incomplete.id, 'completed', {}, {}, incompletePool),
    /checksum-verified/
  );
}

function testPurposeScopedAccess() {
  assert.equal(hasPreservationCapability({ principalType: 'root' }, 'restore_configuration'), true);
  assert.equal(hasPreservationCapability({ principalType: 'platform' }, 'design_exports'), true);
  assert.equal(hasPreservationCapability({ principalType: 'platform' }, 'manage_secrets'), false);
  assert.deepEqual(preservationCapabilities({ principalType: 'tenant' }), []);
}

async function run() {
  testDefinitionDsl();
  testConnectionSafety();
  testSchemaAndInterface();
  testAuditRedaction();
  testPurposeScopedAccess();
  await testCredentialVault();
  await testProtectedCompletionGate();
  await testRouteAuthority();
  console.log('Preservation Phase 1 tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
