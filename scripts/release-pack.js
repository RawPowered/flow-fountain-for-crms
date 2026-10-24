// Dependency-free ZIP writer. Both Windows and Linux receive the same source release.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateRelease } = require('./release-check');
const root = path.resolve(__dirname, '..');
const files = validateRelease();
const version = require('../package.json').version;
const stem = `osint-research-studio-360-fountain-${version}`;
const entries = [];
const directory = [];
let offset = 0;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
for (const file of files) {
  const name = Buffer.from(`${stem}/${file}`);
  const data = fs.readFileSync(path.join(root, file));
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x314, 4);
  central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(((file === 'start.sh' ? 0o100755 : 0o100644) << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  entries.push(header, name, data); directory.push(central, name);
  offset += header.length + name.length + data.length;
}
const central = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...entries, central, end]);
const destination = path.join(root, 'dist');
fs.mkdirSync(destination, { recursive: true });
const filename = `${stem}.zip`;
fs.writeFileSync(path.join(destination, filename), zip);
fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), `${crypto.createHash('sha256').update(zip).digest('hex')}  ${filename}\n`);
console.log(`Created dist/${filename} (${files.length} allowlisted files)`);
