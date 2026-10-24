const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_HOSTS = new Set([
  'registry.npmjs.org', 'github.com', 'opencollective.com', 'dotenvx.com',
  'www.patreon.com', 'feross.org', 'square.link', 'nodejs.org', 'docs.github.com',
  'services.leadconnectorhq.com', 'marketplace.gohighlevel.com',
  'webapi.dncscrub.com', 'www.dncscrub.com', 'api.census.gov',
  'accounts.google.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com',
  'timeapi.io', 'rdap.org', 'schemas.openxmlformats.org', 'json-schema.org',
  'www.w3.org', 'd3js.org',
  'www.gnu.org', 'gnu.org', 'fsf.org', 'www.fsf.org',
]);

function isExampleHost(host) {
  return ['localhost', '127.0.0.1', 'example.com', 'example.org', 'example.net'].includes(host) ||
    /\.(?:invalid|example|test)$/.test(host) || /\.example\.(?:com|org|net)$/.test(host);
}

function entropy(value) {
  const counts = new Map();
  for (const c of value) counts.set(c, (counts.get(c) || 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum - count / value.length * Math.log2(count / value.length), 0);
}

function reviewedScreenshot(file, bytes, media) {
  const entry = media[file];
  if (!/^docs\/assets\/screenshots\/[a-z0-9-]+\.png$/.test(file) ||
      !entry || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) return 'PNG is not an approved documentation screenshot';
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return 'screenshot differs from its reviewed hash';
  if (bytes.length < 45 || bytes.length > 8 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') return 'invalid screenshot PNG';
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 320 || height < 240 || width > 4096 || height > 4096) return 'screenshot dimensions are outside review bounds';
  const allowed = new Set(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'bKGD']);
  let offset = 8, ended = false, pixels = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!allowed.has(type)) return 'screenshot contains unreviewed metadata';
    if (offset + size + 12 > bytes.length) return 'truncated screenshot PNG';
    if (type === 'IDAT') pixels = true;
    offset += size + 12;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !pixels || offset !== bytes.length) return 'invalid screenshot PNG structure';
  return null;
}

function validateRelease(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
  const files = manifest.files;
  const media = manifest.documentationMedia || {};
  const errors = [];
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length) throw new Error('Invalid release manifest');
  const secretPattern = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
  for (const file of files) {
    if (typeof file !== 'string' || file.includes('\\') || file.split('/').some((part) => part === '..') || path.isAbsolute(file)) {
      errors.push('Invalid manifest path'); continue;
    }
    if (/(?:^|\/)(?:node_modules|var|tmp|output|dist|\.git|\.agents|\.cursor|~[^/]*)(?:\/|$)/.test(file) ||
        /(?:^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example' ||
        /\.(?:zip|pem|key|p12|pfx|log|sqlite|db|webp|pdf)$/i.test(file)) {
      errors.push(`${file}: prohibited release file`); continue;
    }
    const fullPath = path.resolve(root, file);
    let info;
    try { info = fs.lstatSync(fullPath); } catch { errors.push(`${file}: missing file`); continue; }
    if (!info.isFile() || info.isSymbolicLink()) { errors.push(`${file}: expected a regular file`); continue; }
    if (/\.png$/i.test(file)) {
      const error = reviewedScreenshot(file, fs.readFileSync(fullPath), media);
      if (error) errors.push(`${file}: ${error}`);
      continue;
    }
    const source = fs.readFileSync(fullPath, 'utf8');
    if (secretPattern.test(source)) errors.push(`${file}: possible credential or private key`);
    for (const match of source.matchAll(/https?:\/\/(?:[^\s/"'`<>@]+@)?([a-zA-Z0-9.-]+)/g)) {
      const host = match[1].toLowerCase();
      if (!PUBLIC_HOSTS.has(host) && !isExampleHost(host) && !(file.startsWith('test/') && host === '169.254.169.254')) errors.push(`${file}: unreviewed URL host`);
    }
    for (const match of source.matchAll(/[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g)) {
      if (!isExampleHost(match[1].toLowerCase())) errors.push(`${file}: non-example email address`);
    }
    if (file !== 'package-lock.json') {
      for (const match of source.matchAll(/["'`]([A-Za-z0-9+/_=-]{32,})["'`]/g)) {
        const value = match[1];
        if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && entropy(value) > 4.2) {
          errors.push(`${file}: high-entropy literal; review before publication`);
        }
      }
    }
  }
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const match of example.matchAll(/^([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|ORIGIN|ORIGINS|URL|FIELD_ID|ALLOWED_HOSTS))=(.*)$/gm)) {
    if (match[2].trim()) errors.push(`.env.example: ${match[1]} must be blank`);
  }
  // Includes staged files, so an accidental git add cannot bypass the allowlist.
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0) {
    const approved = new Set(files);
    for (const file of git.stdout.split('\0').filter(Boolean)) {
      if (!approved.has(file)) errors.push(`${file}: tracked file is outside the release manifest`);
    }
  }
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));
  return files;
}

if (require.main === module) {
  try { console.log(`Release check passed: ${validateRelease().length} approved source files`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateRelease, isExampleHost };
