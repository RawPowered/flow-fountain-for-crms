const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateRelease } = require('../scripts/release-check');
const { isConfiguredCrmOrigin } = require('../src/services/configuredOrigins');
const { getCustomCrmConfig, isLocalDeployment } = require('../src/config');
const { createHash } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-release-check-'));
const files = ['.env.example', 'README.md', 'release-manifest.json'];
function manifest(value = files) {
  fs.writeFileSync(path.join(temp, 'release-manifest.json'), JSON.stringify({files: value}));
}
try {
  fs.writeFileSync(path.join(temp, '.env.example'), 'SESSION_SECRET=\nCRM_APP_ORIGIN=\n');
  fs.writeFileSync(path.join(temp, 'README.md'), 'A blank research project.');
  manifest();
  assert.deepEqual(validateRelease(temp), files);
  // Real credentials are never used by these negative checks.
  fs.writeFileSync(path.join(temp, 'README.md'), ['ghp', 'A'.repeat(40)].join('_'));
  assert.throws(() => validateRelease(temp), /possible credential/);
  fs.writeFileSync(path.join(temp, 'README.md'), 'A blank research project.');
  fs.writeFileSync(path.join(temp, '.env.example'), 'SESSION_SECRET=fixture-value\n');
  assert.throws(() => validateRelease(temp), /must be blank/);
  fs.writeFileSync(path.join(temp, '.env.example'), 'SESSION_SECRET=\n');
  manifest([...files, '../private.txt']);
  assert.throws(() => validateRelease(temp), /Invalid manifest path/);
  manifest([...files, '.env']);
  assert.throws(() => validateRelease(temp), /prohibited release file/);

  const screenshot = 'docs/assets/screenshots/blank-installation.png';
  const screenshotBytes = fs.readFileSync(path.join(__dirname, '..', screenshot));
  const copiedScreenshot = path.join(temp, screenshot);
  fs.mkdirSync(path.dirname(copiedScreenshot), {recursive: true});
  fs.writeFileSync(copiedScreenshot, screenshotBytes);
  manifest([...files, screenshot]);
  assert.throws(() => validateRelease(temp), /not an approved documentation screenshot/);
  const reviewed = {files:[...files, screenshot], documentationMedia:{
    [screenshot]:{sha256:createHash('sha256').update(screenshotBytes).digest('hex')},
  }};
  fs.writeFileSync(path.join(temp, 'release-manifest.json'), JSON.stringify(reviewed));
  assert.deepEqual(validateRelease(temp), [...files, screenshot]);
  fs.appendFileSync(copiedScreenshot, 'unreviewed change');
  assert.throws(() => validateRelease(temp), /differs from its reviewed hash/);
  reviewed.documentationMedia[screenshot].sha256 = createHash('sha256')
    .update(fs.readFileSync(copiedScreenshot)).digest('hex');
  fs.writeFileSync(path.join(temp, 'release-manifest.json'), JSON.stringify(reviewed));
  assert.throws(() => validateRelease(temp), /invalid screenshot PNG structure/);

  delete process.env.CRM_ALLOWED_ORIGINS;
  delete process.env.CUSTOM_CRM_BASE_URL;
  delete process.env.CUSTOM_CRM_PROXY_ENABLED;
  delete process.env.HOST;
  delete process.env.LOCAL_DEVELOPMENT;
  assert.equal(isConfiguredCrmOrigin('https://crm.example.invalid'), false);
  process.env.CRM_ALLOWED_ORIGINS = 'https://crm.example.invalid';
  assert.equal(isConfiguredCrmOrigin('https://crm.example.invalid/backend'), true);
  assert.equal(isConfiguredCrmOrigin('https://child.crm.example.invalid'), false);
  assert.equal(isConfiguredCrmOrigin('https://crm.example.invalid.evil.example'), false);
  assert.equal(isConfiguredCrmOrigin('http://crm.example.invalid'), false);
  assert.equal(getCustomCrmConfig().enabled, false);
  assert.equal(isLocalDeployment(), true);
  process.env.HOST = '0.0.0.0';
  assert.equal(isLocalDeployment(), false);
  console.log('Release privacy guard and blank adapter defaults passed');
} finally {
  // Only this freshly created test-owned temporary directory is removed.
  fs.rmSync(temp, {recursive: true, force: true});
}
