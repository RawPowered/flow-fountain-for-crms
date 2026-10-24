const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { getSecretBoxKey } = require('../config');

const ENVELOPE_MAGIC = Buffer.from('FSENC002');
const XLSX_MAX_ROWS = 1048576;
const FORMAT_INFO = Object.freeze({
  csv: { extension: 'csv', mediaType: 'text/csv; charset=utf-8' },
  xml: { extension: 'xml', mediaType: 'application/xml; charset=utf-8' },
  xlsx: { extension: 'xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  sql: { extension: 'sql', mediaType: 'application/sql; charset=utf-8' },
});

async function renderArtifact({ format, mappings, formatConfig, records, plainPath, maxBytes }) {
  const info = FORMAT_INFO[format];
  if (!info) throw rendererError('FORMAT_UNSUPPORTED', 'Unsupported export format');
  await fs.promises.mkdir(path.dirname(plainPath), { recursive: true });
  let result;
  if (format === 'csv') result = await renderCsv(plainPath, mappings, formatConfig, records);
  else if (format === 'xml') result = await renderXml(plainPath, mappings, formatConfig, records);
  else if (format === 'sql') result = await renderSql(plainPath, mappings, formatConfig, records);
  else result = await renderXlsx(plainPath, mappings, formatConfig, records);
  const stat = await fs.promises.stat(plainPath);
  if (stat.size > maxBytes) {
    await fs.promises.rm(plainPath, { force: true });
    throw rendererError('ARTIFACT_TOO_LARGE', 'Rendered artifact exceeds configured size limit');
  }
  return { ...result, ...info, byteCount: stat.size, plainPath };
}

async function renderCsv(filePath, mappings, config, records) {
  const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  const newline = config.newline === 'crlf' ? '\r\n' : '\n';
  const delimiter = config.delimiter || ',';
  let count = 0;
  try {
    if (config.includeHeader !== false) {
      await write(output, mappings.map((item) => csvCell(item.target, delimiter)).join(delimiter) + newline);
    }
    for await (const record of records) {
      await write(output, mappings.map((item) => csvCell(record[item.target], delimiter)).join(delimiter) + newline);
      count += 1;
    }
    output.end();
    await once(output, 'close');
    return { recordCount: count };
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function csvCell(value, delimiter) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function renderXml(filePath, mappings, config, records) {
  const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  const root = config.rootElement || 'export';
  const row = config.rowElement || 'record';
  let count = 0;
  try {
    if (config.declaration !== false) await write(output, '<?xml version="1.0" encoding="UTF-8"?>\n');
    await write(output, `<${root}>\n`);
    for await (const record of records) {
      await write(output, `  <${row}>`);
      for (const mapping of mappings) {
        const value = record[mapping.target];
        if (value == null) await write(output, `<${mapping.target} />`);
        else await write(output, `<${mapping.target}>${xmlEscape(serialized(value))}</${mapping.target}>`);
      }
      await write(output, `</${row}>\n`);
      count += 1;
    }
    await write(output, `</${root}>\n`);
    output.end();
    await once(output, 'close');
    return { recordCount: count };
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function renderSql(filePath, mappings, config, records) {
  const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  const table = quoteSqlIdentifier(config.tableName || 'workbench_export', config.dialect);
  const columns = mappings.map((item) => quoteSqlIdentifier(item.target, config.dialect));
  const batchSize = Number(config.batchSize) || 500;
  let batch = [];
  let count = 0;
  try {
    await write(output, '-- Portable Workbench data export; data statements only.\n');
    await write(output, 'BEGIN;\n');
    if (config.includeCreate !== false) {
      const definitions = mappings.map((item) =>
        `${quoteSqlIdentifier(item.target, config.dialect)} ${sqlType(item.type, config.dialect)}`);
      await write(output, `CREATE TABLE IF NOT EXISTS ${table} (${definitions.join(', ')});\n`);
    }
    for await (const record of records) {
      batch.push(`(${mappings.map((item) => sqlLiteral(record[item.target], config.dialect)).join(',')})`);
      count += 1;
      if (batch.length >= batchSize) {
        await write(output, `INSERT INTO ${table} (${columns.join(',')}) VALUES\n${batch.join(',\n')};\n`);
        batch = [];
      }
    }
    if (batch.length) {
      await write(output, `INSERT INTO ${table} (${columns.join(',')}) VALUES\n${batch.join(',\n')};\n`);
    }
    await write(output, 'COMMIT;\n');
    output.end();
    await once(output, 'close');
    return { recordCount: count };
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function quoteSqlIdentifier(value, dialect = 'mysql') {
  const identifier = String(value);
  return dialect === 'mysql' ? `\`${identifier.replace(/`/g, '``')}\`` : `"${identifier.replace(/"/g, '""')}"`;
}

function sqlType(type, dialect) {
  if (type === 'number') return 'DECIMAL(30,10)';
  if (type === 'boolean') return dialect === 'mysql' ? 'TINYINT(1)' : 'BOOLEAN';
  if (type === 'date') return 'DATE';
  if (type === 'datetime') return 'TIMESTAMP';
  if (type === 'json') return dialect === 'postgresql' ? 'JSONB' : 'TEXT';
  return 'TEXT';
}

function sqlLiteral(value, dialect) {
  if (value == null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return dialect === 'postgresql' ? (value ? 'TRUE' : 'FALSE') : (value ? '1' : '0');
  const text = serialized(value).replace(/'/g, "''").replace(/\u0000/g, '');
  return `'${text}'`;
}

async function renderXlsx(filePath, mappings, config, records) {
  const worksheetPath = `${filePath}.worksheet`;
  const sheet = fs.createWriteStream(worksheetPath, { flags: 'wx', mode: 0o600 });
  const columnDefinitions = mappings.map((item, index) => {
    const width = Math.min(36, Math.max(12, String(item.target || item.source || '').length + 4));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  let rowNumber = 1;
  try {
    await write(sheet, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `<cols>${columnDefinitions}</cols><sheetData>`);
    await write(sheet, xlsxRow(rowNumber, mappings.map((item) => item.target), true));
    for await (const record of records) {
      rowNumber += 1;
      if (rowNumber > XLSX_MAX_ROWS) throw rendererError('XLSX_ROW_LIMIT', 'XLSX row limit exceeded');
      await write(sheet, xlsxRow(rowNumber, mappings.map((item) => record[item.target])));
    }
    const autoFilter = config.autoFilter === false
      ? ''
      : `<autoFilter ref="A1:${columnName(mappings.length)}${rowNumber}"/>`;
    await write(sheet, `</sheetData>${autoFilter}</worksheet>`);
    sheet.end();
    await once(sheet, 'close');
    const zip = new ZipStoreWriter(filePath);
    await zip.open();
    await zip.addBuffer('[Content_Types].xml', contentTypesXml());
    await zip.addBuffer('_rels/.rels', rootRelationshipsXml());
    await zip.addBuffer('xl/workbook.xml', workbookXml(config.sheetName || 'Export'));
    await zip.addBuffer('xl/_rels/workbook.xml.rels', workbookRelationshipsXml());
    await zip.addBuffer('xl/styles.xml', stylesXml());
    await zip.addFile('xl/worksheets/sheet1.xml', worksheetPath);
    await zip.close();
    return { recordCount: rowNumber - 1 };
  } finally {
    if (!sheet.closed) sheet.destroy();
    await fs.promises.rm(worksheetPath, { force: true }).catch(() => {});
  }
}

function xlsxRow(rowNumber, values, header = false) {
  const cells = values.map((value, index) =>
    xlsxCell(`${columnName(index + 1)}${rowNumber}`, value, header ? 1 : 0)).join('');
  return `<row r="${rowNumber}">${cells}</row>`;
}

function xlsxCell(reference, value, style = 0) {
  const styleAttribute = style ? ` s="${style}"` : '';
  if (value == null) return `<c r="${reference}"${styleAttribute} />`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"${styleAttribute}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}"${styleAttribute} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${reference}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(serialized(value))}</t></is></c>`;
}

function columnName(number) {
  let value = number;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function contentTypesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
}

function rootRelationshipsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
}

function workbookXml(sheetName) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

function workbookRelationshipsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
}

function stylesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF123B66"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>' +
    '<cellXfs count="2"><xf xfId="0"/>' +
    '<xf xfId="0" fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1">' +
    '<alignment vertical="center"/></xf></cellXfs></styleSheet>';
}

class ZipStoreWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.handle = null;
    this.offset = 0;
    this.entries = [];
  }

  async open() {
    this.handle = await fs.promises.open(this.filePath, 'wx', 0o600);
  }

  async addBuffer(name, value) {
    const buffer = Buffer.from(value);
    await this.add(name, (async function* () { yield buffer; })());
  }

  async addFile(name, filePath) {
    await this.add(name, fs.createReadStream(filePath));
  }

  async add(name, chunks) {
    const nameBuffer = Buffer.from(name);
    const localOffset = this.offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(0, 8);
    dosDateTime(local, 10);
    local.writeUInt16LE(nameBuffer.length, 26);
    await this.write(local);
    await this.write(nameBuffer);
    let crc = 0xffffffff;
    let size = 0;
    for await (const chunkValue of chunks) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      crc = crc32Update(crc, chunk);
      size += chunk.length;
      await this.write(chunk);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    this.entries.push({ nameBuffer, localOffset, crc, size });
  }

  async close() {
    const centralOffset = this.offset;
    for (const entry of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x08, 8);
      central.writeUInt16LE(0, 10);
      dosDateTime(central, 12);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(entry.size, 20);
      central.writeUInt32LE(entry.size, 24);
      central.writeUInt16LE(entry.nameBuffer.length, 28);
      central.writeUInt32LE(entry.localOffset, 42);
      await this.write(central);
      await this.write(entry.nameBuffer);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await this.write(end);
    await this.handle.close();
    this.handle = null;
  }

  async write(buffer) {
    await this.handle.write(buffer, 0, buffer.length, this.offset);
    this.offset += buffer.length;
  }
}

async function encryptArtifact(plainPath, encryptedPath) {
  const master = artifactMasterKey();
  const dataKey = crypto.randomBytes(32);
  const dataIv = crypto.randomBytes(12);
  const wrapIv = crypto.randomBytes(12);
  const wrapper = crypto.createCipheriv('aes-256-gcm', master, wrapIv);
  const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);
  const wrapTag = wrapper.getAuthTag();
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, dataIv);
  const output = await fs.promises.open(encryptedPath, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let byteCount = 0;
  const append = async (buffer) => {
    await output.write(buffer, 0, buffer.length, byteCount);
    byteCount += buffer.length;
    hash.update(buffer);
  };
  try {
    await append(Buffer.concat([ENVELOPE_MAGIC, dataIv]));
    for await (const chunk of fs.createReadStream(plainPath)) {
      const encrypted = cipher.update(chunk);
      if (encrypted.length) await append(encrypted);
    }
    const final = cipher.final();
    if (final.length) await append(final);
    await append(cipher.getAuthTag());
    await output.close();
    return {
      encryptedPath,
      byteCount,
      sha256: hash.digest('hex'),
      encryption: {
        algorithm: 'AES-256-GCM',
        envelopeVersion: 2,
        wrappedKey: wrappedKey.toString('base64'),
        wrapIv: wrapIv.toString('base64'),
        wrapTag: wrapTag.toString('base64'),
      },
    };
  } catch (error) {
    await output.close().catch(() => {});
    await fs.promises.rm(encryptedPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    dataKey.fill(0);
    await fs.promises.rm(plainPath, { force: true }).catch(() => {});
  }
}

async function createDecryptionStream(encryptedPath, metadata) {
  const stat = await fs.promises.stat(encryptedPath);
  if (stat.size < ENVELOPE_MAGIC.length + 12 + 16) throw rendererError('ENVELOPE_INVALID', 'Encrypted artifact is truncated');
  const handle = await fs.promises.open(encryptedPath, 'r');
  const header = Buffer.alloc(20);
  const tag = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, stat.size - 16);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, 8).equals(ENVELOPE_MAGIC)) throw rendererError('ENVELOPE_INVALID', 'Unknown artifact envelope');
  const master = artifactMasterKey();
  const unwrapper = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(metadata.wrapIv, 'base64'));
  unwrapper.setAuthTag(Buffer.from(metadata.wrapTag, 'base64'));
  const dataKey = Buffer.concat([
    unwrapper.update(Buffer.from(metadata.wrappedKey, 'base64')),
    unwrapper.final(),
  ]);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, header.subarray(8, 20));
  decipher.setAuthTag(tag);
  const source = fs.createReadStream(encryptedPath, { start: 20, end: stat.size - 17 });
  source.on('close', () => dataKey.fill(0));
  return source.pipe(decipher);
}

function artifactMasterKey() {
  const secret = getSecretBoxKey();
  if (!secret) throw rendererError('ARTIFACT_KEY_MISSING', 'SECRET_BOX_KEY is required for artifact encryption');
  return crypto.scryptSync(secret, 'workbench-preservation-artifact-v2', 32);
}

function dosDateTime(buffer, offset) {
  const date = new Date();
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) |
    Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) |
    ((date.getMonth() + 1) << 5) | date.getDate();
  buffer.writeUInt16LE(time, offset);
  buffer.writeUInt16LE(day, offset + 2);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32Update(crc, buffer) {
  let value = crc >>> 0;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function serialized(value) {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

async function write(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

function rendererError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  FORMAT_INFO,
  renderArtifact,
  encryptArtifact,
  createDecryptionStream,
  csvCell,
  sqlLiteral,
  xmlEscape,
  columnName,
};
