const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parrot = require('../src/services/parrot');
const parrotStudio = require('../src/services/parrotStudio');

class FakePool {
  constructor(existing = null) { this.existing = existing; this.queries = []; }
  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (/SELECT \* FROM parrot_runs WHERE api_key_id/.test(sql)) return [[...(this.existing ? [this.existing] : [])]];
    return [{ affectedRows:1 }];
  }
}

async function main() {
  const original = {
    url:process.env.PARROT_BASE_URL,
    token:process.env.PARROT_SERVICE_TOKEN,
    timeout:process.env.PARROT_TIMEOUT_MS,
  };
  process.env.PARROT_BASE_URL = 'http://127.0.0.1:8765';
  process.env.PARROT_SERVICE_TOKEN = 'unit-test-token';
  process.env.PARROT_TIMEOUT_MS = '5000';
  try {
    const normalized = parrot.normalizeRun({
      apiKeyId:'key-1', locationId:'location-1', dataSourceSlug:'core', source:'hawk', mode:'live',
      scriptId:'text.normalize', inputs:{ text:'Hello', serviceToken:'redact-me' }, timeoutMs:2000,
    }, { requestId:'request-1', actorId:'admin-1' }, { timeoutMs:5000 });
    assert.equal(normalized.scriptId, 'text.normalize');
    assert.equal(normalized.inputs.serviceToken, '[redacted]');
    assert.equal(normalized.timeoutMs, 2000);
    const sourcePackage = parrot.normalizeSourcePackage({
      source:'def run(inputs, context):\n    return inputs',
      sha256:'a'.repeat(64), capabilities:['network.dns','network.http','network.dns'], approved:true,
    });
    assert.deepEqual(sourcePackage.capabilities, []);
    assert.equal(sourcePackage.approved, true);
    const manifestA = parrotStudio.manifestHash(sourcePackage.source, [], { type:'object', properties:{} });
    const manifestB = parrotStudio.manifestHash(sourcePackage.source, ['network.dns'], { properties:{}, type:'object' });
    assert.notEqual(manifestA, manifestB);

    const root = path.join(__dirname, '..');
    const samplePackage = JSON.parse(fs.readFileSync(path.join(root, 'public/data/parrot-script-template.json'), 'utf8'));
    const imported = parrotStudio.normalizeImportPackage(samplePackage);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].slug, 'custom.research-step');
    assert.deepEqual(imported[0].capabilities, []);
    const liveSchema = parrotStudio.buildImportSchema({
      objects:[{ id:'contact', label:'Contact' }],
      fields:[{ label:'Website', objectModel:'contact', runtimePath:'trigger.website', template:'{{trigger.website}}', fieldId:null, fieldKey:'website', dataType:'string', allowedValues:[], writable:true }],
    });
    assert.equal(liveSchema.properties.format.const, 'parrot-script-1');
    assert.equal(liveSchema['x-parrot-catalog'].crmFields[0].hawkTemplate, '{{trigger.website}}');
    assert.equal(parrotStudio.uniqueImportIdentity(imported[0], [imported[0].slug]).slug, 'custom.research-step-2');
    assert.throws(
      () => parrotStudio.normalizeImportPackage({ ...samplePackage, scripts:[...samplePackage.scripts, ...samplePackage.scripts] }),
      (error) => error.code === 'PARROT_IMPORT_DUPLICATE_SCRIPT'
    );
    assert.throws(
      () => parrotStudio.normalizeImportPackage({ ...samplePackage, scripts:[{ ...samplePackage.scripts[0], capabilities:['network.shell'] }] }),
      (error) => error.code === 'PARROT_IMPORT_CAPABILITIES_INVALID'
    );
    const exported = parrotStudio.buildExportPackage({
      id:'script-1', slug:imported[0].slug, name:imported[0].name, description:imported[0].description,
      latestVersionId:'version-1', versions:[{ id:'version-1', version:3, source:imported[0].source, capabilities:imported[0].capabilities, inputSchema:imported[0].inputSchema }],
    });
    assert.equal(exported.format, 'parrot-script-1');
    assert.equal(exported.generatedFor.version, 3);

    const pool = new FakePool();
    const fetchImpl = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:8765/v1/runs');
      assert.equal(init.headers.Authorization, 'Bearer unit-test-token');
      const request = JSON.parse(init.body);
      assert.equal(request.contractVersion, 'parrot.v1');
      assert.equal(request.context.locationId, 'location-1');
      return new Response(JSON.stringify({
        ok:true, contractVersion:'parrot.v1', requestId:'request-1', runId:request.runId,
        status:'completed', script:{ id:'text.normalize', version:'1.0.0' },
        output:{ text:'hello' }, metrics:{ durationMs:12, outputBytes:16 }, warnings:[],
      }), { status:200, headers:{ 'content-type':'application/json' } });
    };
    const run = await parrot.runScript({
      apiKeyId:'key-1', locationId:'location-1', dataSourceSlug:'core', source:'hawk', mode:'live',
      scriptId:'text.normalize', inputs:{ text:'Hello' }, idempotencyKey:'hawk:execution:node',
    }, { requestId:'request-1', actorId:'admin-1', telemetry:false }, pool, fetchImpl);
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.output, { text:'hello' });
    assert.equal(run.durationMs, 12);
    assert.ok(pool.queries.some((item) => /INSERT INTO parrot_runs/.test(item.sql)));
    assert.ok(pool.queries.some((item) => /status='completed'/.test(item.sql)));

    await assert.rejects(
      () => parrot.requestJson('https://parrot.example/healthz', { method:'GET' }, 1000, async () => new Response(
        '<!doctype html><title>500 Internal Server Error</title>',
        { status:500, headers:{ 'content-type':'text/html' } }
      ), false),
      (error) => error.code === 'PARROT_RESPONSE_NON_JSON'
        && /HTTP 500; text\/html/.test(error.message)
    );

    const safe = parrot.safeData({ password:'secret', nested:{ apiKey:'secret', value:4 } });
    assert.deepEqual(safe, { password:'[redacted]', nested:{ apiKey:'[redacted]', value:4 } });

    const html = fs.readFileSync(path.join(root, 'public/admin/parrot.html'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'public/js/parrot-console.js'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
    const schema = fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8');
    assert.match(html, /id="scriptList"/);
    assert.match(html, /id="studioWorkspace"/);
    assert.match(html, /id="studioSource"/);
    assert.match(html, /AI Rules/);
    assert.match(html, /Export CRM Fields/);
    assert.match(html, /Sample Python Script/);
    assert.match(html, /id="studioImportDialog"/);
    assert.match(html, /id="runRows"/);
    assert.match(client, /\/api\/parrot\/runs/);
    assert.match(client, /\/api\/parrot\/scripts/);
    assert.match(client, /\/api\/parrot\/imports\/preview/);
    assert.match(app, /createAdminParrotRouter/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS parrot_runs/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS parrot_scripts/);
    assert.match(schema, /manifest_sha256/);

    await assert.rejects(
      () => parrot.runScript({ apiKeyId:'key-1', locationId:'location-1', source:'hawk', mode:'live', scriptId:'bad id', inputs:{} }, { telemetry:false }, new FakePool(), fetchImpl),
      (error) => error.code === 'PARROT_SCRIPT_ID_INVALID'
    );
  } finally {
    if (original.url === undefined) delete process.env.PARROT_BASE_URL; else process.env.PARROT_BASE_URL = original.url;
    if (original.token === undefined) delete process.env.PARROT_SERVICE_TOKEN; else process.env.PARROT_SERVICE_TOKEN = original.token;
    if (original.timeout === undefined) delete process.env.PARROT_TIMEOUT_MS; else process.env.PARROT_TIMEOUT_MS = original.timeout;
  }
  console.log('PARROT bridge tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
