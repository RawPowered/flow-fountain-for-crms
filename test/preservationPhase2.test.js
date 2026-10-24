const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { SCHEMA_VERSION } = require('../src/config');
const preservation = require('../src/services/preservation');
const {
  renderArtifact,
  encryptArtifact,
  createDecryptionStream,
} = require('../src/services/preservationRenderers');
const {
  mapAndFilterStream,
} = require('../src/services/preservationSources');
const {
  storageUri,
  resolveStorageUri,
  safeObjectKey,
} = require('../src/services/preservationDestinations');
const {
  cronMatches,
  safeJobFolder,
} = require('../src/services/preservationWorker');

const mappings = [
  { source: 'id', target: 'id', type: 'number', transform: 'none', required: true },
  { source: 'name', target: 'name', type: 'string', transform: 'none', required: true },
  { source: 'active', target: 'active', type: 'boolean', transform: 'none', required: false },
];
const rows = [
  { id: 1, name: 'Alpha, "One"', active: true },
  { id: 2, name: 'Beta & <Two>', active: false },
];

async function records() {
  return Readable.from(rows.map((row) => ({ ...row })), { objectMode: true });
}

async function run() {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'workbench-phase2-'));
  const previousKey = process.env.SECRET_BOX_KEY;
  process.env.SECRET_BOX_KEY = 'phase-2-artifact-encryption-test-key';
  try {
    const outputs = {};
    for (const format of ['csv', 'xml', 'xlsx', 'sql']) {
      const filePath = path.join(temp, `artifact.${format}`);
      outputs[format] = await renderArtifact({
        format,
        mappings,
        formatConfig: preservation.validateFormatConfig(format, {}),
        records: await records(),
        plainPath: filePath,
        maxBytes: 10 * 1024 * 1024,
      });
      assert.equal(outputs[format].recordCount, 2);
      assert.ok(outputs[format].byteCount > 0);
    }

    const csv = await fs.promises.readFile(outputs.csv.plainPath, 'utf8');
    assert.match(csv, /"Alpha, ""One"""/);
    const xml = await fs.promises.readFile(outputs.xml.plainPath, 'utf8');
    assert.match(xml, /Beta &amp; &lt;Two&gt;/);
    const sql = await fs.promises.readFile(outputs.sql.plainPath, 'utf8');
    assert.match(sql, /INSERT INTO `workbench_export`/);
    assert.match(sql, /COMMIT;/);
    const xlsx = await fs.promises.readFile(outputs.xlsx.plainPath);
    assert.equal(xlsx.subarray(0, 2).toString(), 'PK');
    assert.match(xlsx.toString('utf8'), /xl\/worksheets\/sheet1\.xml/);
    assert.match(xlsx.toString('utf8'), /Beta &amp; &lt;Two&gt;/);
    if (process.env.PRESERVATION_XLSX_VERIFY_PATH) {
      await fs.promises.copyFile(outputs.xlsx.plainPath, process.env.PRESERVATION_XLSX_VERIFY_PATH);
    }

    const encryptedPath = `${outputs.csv.plainPath}.fse`;
    const encrypted = await encryptArtifact(outputs.csv.plainPath, encryptedPath);
    assert.equal(fs.existsSync(outputs.csv.plainPath), false);
    assert.equal(encrypted.sha256.length, 64);
    const encryptedBytes = await fs.promises.readFile(encryptedPath);
    assert.equal(encryptedBytes.includes(Buffer.from('Alpha, "One"')), false);
    const decrypted = await createDecryptionStream(encryptedPath, encrypted.encryption);
    const chunks = [];
    for await (const chunk of decrypted) chunks.push(chunk);
    assert.match(Buffer.concat(chunks).toString('utf8'), /Alpha/);

    const stats = {};
    async function* canonical() {
      yield { record: { id: 1, name: 'ALPHA', active: true }, cursor: 1 };
      yield { record: { id: 2, name: 'BETA', active: false }, cursor: 2 };
    }
    const mapped = mapAndFilterStream(canonical(), {
      mappings: [
        { source: 'id', target: 'id', type: 'number', transform: 'none', required: true },
        { source: 'name', target: 'name', type: 'string', transform: 'lowercase' },
      ],
      filters: [{ field: 'active', operator: 'eq', value: true }],
    }, stats);
    const mappedRows = [];
    for await (const row of mapped) mappedRows.push(row);
    assert.deepEqual(mappedRows, [{ id: 1, name: 'alpha' }]);
    assert.equal(stats.filtered, 1);

    assert.equal(storageUri('job-1', 'export.csv.fse'), 'staging://job-1/export.csv.fse');
    assert.equal(
      resolveStorageUri('staging://job-1/export.csv.fse', temp),
      path.resolve(temp, 'jobs', 'job-1', 'export.csv.fse')
    );
    assert.throws(() => resolveStorageUri('staging://job-1/../secret', temp), /Invalid artifact/);
    assert.equal(safeObjectKey('daily/archive', 'export.csv'), 'daily/archive/export.csv.enc');
    assert.equal(safeJobFolder(temp, 'job-1'), path.resolve(temp, 'jobs', 'job-1'));

    const scheduled = new Date('2026-07-28T02:00:00.000Z');
    assert.equal(cronMatches('0 2 * * *', scheduled), true);
    assert.equal(cronMatches('30 2 * * *', scheduled), false);

    const schema = await fs.promises.readFile(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
    assert.match(schema, /lease_expires_at\s+TIMESTAMP\(3\)/);
    assert.match(schema, /attempt_count\s+SMALLINT UNSIGNED/);
    assert.ok(Number(SCHEMA_VERSION) >= 49);
    const server = await fs.promises.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /startPreservationWorker/);
    const packageJson = require('../package.json');
    assert.ok(packageJson.dependencies['ssh2-sftp-client']);

    console.log('Preservation Phase 2 tests passed');
  } finally {
    if (previousKey === undefined) delete process.env.SECRET_BOX_KEY;
    else process.env.SECRET_BOX_KEY = previousKey;
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
