const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
// Synthetic field mappings belong to tests, never runtime defaults.
const env = { ...process.env, NODE_ENV: 'test',
  CRM_ALTERNATIVE_PHONE_FIELD_ID: 'fixture-field-02',
  CRM_PHONE_3_FIELD_ID: 'fixture-field-03',
  CRM_ASSIGNED_DIALER_FIELD_ID: 'fixture-field-01',
  CRM_ALLOWED_ORIGINS: 'https://crm.example.invalid,https://api.example.invalid,https://crm-api.example.invalid',
  CRM_APP_ORIGIN: 'https://crm.example.invalid',
};
let failed = 0;
const files = fs.readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.js')).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(root, 'test', file)], {
    cwd: root, env, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    failed++;
    console.error(`FAIL ${file}\n${result.stdout || ''}${result.stderr || ''}${result.error || ''}`);
  } else console.log(`PASS ${file}`);
}
console.log(`${files.length - failed}/${files.length} test files passed`);
process.exitCode = failed ? 1 : 0;
