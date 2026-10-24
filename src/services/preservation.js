const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { recordPreservationAudit } = require('./preservationAudit');
const { assertSlug, getDestination, getIntegration } = require('./integrationManagement');

const EXPORT_FORMATS = Object.freeze(['csv', 'xml', 'xlsx', 'sql']);
const SOURCE_TYPES = Object.freeze(['catalog', 'integration', 'crm_integration', 'sql_connection']);
const SOURCE_CATALOG = Object.freeze([
  'customer_directory',
  'leads_contacts',
  'appointments_outcomes',
  'dialer_operations',
  'schedules_routing',
  'automation_definitions',
  'automation_activity',
  'eagle_analytics',
  'external_sql_dataset',
  'configuration_package',
]);
const VALUE_TYPES = Object.freeze(['string', 'number', 'boolean', 'date', 'datetime', 'json']);
const TRANSFORMS = Object.freeze(['none', 'trim', 'lowercase', 'uppercase']);
const FILTER_OPERATORS = Object.freeze([
  'eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'not_null',
]);
const JOB_TYPES = Object.freeze(['export', 'configuration_backup', 'disaster_recovery']);
const JOB_STATES = Object.freeze([
  'queued', 'extracting', 'rendering', 'delivering', 'completed', 'failed', 'cancelled',
]);
const JOB_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['extracting', 'cancelled']),
  extracting: Object.freeze(['rendering', 'failed', 'cancelled']),
  rendering: Object.freeze(['delivering', 'failed', 'cancelled']),
  delivering: Object.freeze(['completed', 'failed', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_.\-[\]]{0,254}$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const XML_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const FORBIDDEN_DSL_KEY_RE = /^(?:sql|rawsql|query|code|script|command|shell|exec)$/i;
const MAX_JSON_BYTES = 512 * 1024;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function requiredText(value, label, max = 160) {
  const text = String(value || '').trim();
  if (!text) throw badRequest(`${label} is required`);
  return text.slice(0, max);
}

function normalizeDefinition(input, existing = {}) {
  const sourceType = input.sourceType == null ? existing.source_type : String(input.sourceType).trim();
  if (!SOURCE_TYPES.includes(sourceType)) throw badRequest('Unsupported source type');
  const sourceKey = input.sourceKey == null
    ? existing.source_key
    : requiredText(input.sourceKey, 'sourceKey', 96);
  if (!/^[a-z][a-z0-9_.-]{1,95}$/.test(sourceKey)) throw badRequest('Invalid sourceKey');
  if (sourceType === 'catalog' && !SOURCE_CATALOG.includes(sourceKey)) {
    throw badRequest('Unknown source catalog key');
  }
  const sourceRefId = input.sourceRefId === undefined
    ? existing.source_ref_id || null
    : String(input.sourceRefId || '').trim().slice(0, 191) || null;
  if (sourceType !== 'catalog' && !sourceRefId) throw badRequest('sourceRefId is required');
  const format = input.format == null
    ? existing.export_format
    : String(input.format).trim().toLowerCase();
  if (!EXPORT_FORMATS.includes(format)) throw badRequest('Unsupported export format');
  const retentionDays = input.retentionDays == null
    ? Number(existing.retention_days || 30)
    : Number(input.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw badRequest('retentionDays must be between 1 and 365');
  }
  const scheduleCron = input.scheduleCron === undefined
    ? existing.schedule_cron || null
    : String(input.scheduleCron || '').trim().slice(0, 128) || null;
  if (scheduleCron && !validCronShape(scheduleCron)) {
    throw badRequest('scheduleCron must contain five standard cron fields');
  }
  return {
    slug: input.slug == null ? existing.slug : assertSlug(input.slug),
    name: input.name == null ? existing.name : requiredText(input.name, 'name'),
    description: input.description === undefined
      ? existing.description || null
      : String(input.description || '').trim().slice(0, 1000) || null,
    locationId: input.locationId === undefined
      ? existing.location_id || null
      : String(input.locationId || '').trim().slice(0, 128) || null,
    sourceType,
    sourceRefId,
    sourceKey,
    destinationId: input.destinationId === undefined
      ? existing.destination_id || null
      : String(input.destinationId || '').trim() || null,
    format,
    retentionDays,
    scheduleCron,
  };
}

function validCronShape(value) {
  return String(value).trim().split(/\s+/).length === 5 &&
    /^[A-Za-z0-9*/?,.-]+(?:\s+[A-Za-z0-9*/?,.-]+){4}$/.test(String(value).trim());
}

function normalizeVersionPayload(input, format) {
  const sourceConfig = safeDslObject(input.sourceConfig || {}, 'sourceConfig');
  const mappings = validateMappings(input.mappings, format);
  const filters = validateFilters(input.filters || []);
  const formatConfig = validateFormatConfig(format, input.formatConfig || {});
  const canonical = { sourceConfig, mappings, filters, formatConfig };
  const encoded = stableStringify(canonical);
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw badRequest('Export definition exceeds 512 KB');
  return {
    ...canonical,
    schemaSha256: crypto.createHash('sha256').update(encoded).digest('hex'),
  };
}

function safeDslObject(value, label, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${label} must be a JSON object`);
  }
  if (depth > 8) throw badRequest(`${label} nesting is too deep`);
  const output = {};
  Object.entries(value).forEach(([key, item]) => {
    if (FORBIDDEN_DSL_KEY_RE.test(key)) {
      throw badRequest(`${label} cannot contain arbitrary SQL, code, scripts, or commands`);
    }
    const safeKey = String(key).slice(0, 128);
    if (Array.isArray(item)) {
      output[safeKey] = item.slice(0, 500).map((child) => {
        if (child && typeof child === 'object') return safeDslObject(child, label, depth + 1);
        return scalar(child);
      });
    } else if (item && typeof item === 'object') {
      output[safeKey] = safeDslObject(item, label, depth + 1);
    } else {
      output[safeKey] = scalar(item);
    }
  });
  return output;
}

function scalar(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  return String(value).slice(0, 4000);
}

function validateMappings(value, format) {
  if (!Array.isArray(value) || !value.length) throw badRequest('At least one field mapping is required');
  if (value.length > 500) throw badRequest('A definition may contain at most 500 field mappings');
  const targets = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest(`Mapping ${index + 1} must be an object`);
    }
    const source = requiredText(item.source, `Mapping ${index + 1} source`, 255);
    if (!PATH_RE.test(source)) throw badRequest(`Mapping ${index + 1} has an invalid source path`);
    const target = requiredText(item.target, `Mapping ${index + 1} target`, 128);
    if (format === 'sql' && !IDENT_RE.test(target)) {
      throw badRequest(`SQL target "${target}" must be a safe identifier`);
    }
    if (format === 'xml' && !XML_NAME_RE.test(target)) {
      throw badRequest(`XML target "${target}" must be a safe element name`);
    }
    if (/[\r\n\t]/.test(target)) throw badRequest('Mapping targets cannot contain control characters');
    const normalizedTarget = format === 'sql' ? target.toLowerCase() : target;
    if (targets.has(normalizedTarget)) throw badRequest(`Duplicate mapping target: ${target}`);
    targets.add(normalizedTarget);
    const type = String(item.type || 'string').toLowerCase();
    if (!VALUE_TYPES.includes(type)) throw badRequest(`Unsupported mapping type: ${type}`);
    const transform = String(item.transform || 'none').toLowerCase();
    if (!TRANSFORMS.includes(transform)) throw badRequest(`Unsupported declarative transform: ${transform}`);
    return {
      source,
      target,
      type,
      transform,
      required: Boolean(item.required),
      default: item.default == null ? null : scalar(item.default),
      format: item.format == null ? null : String(item.format).slice(0, 128),
      nullValue: item.nullValue == null ? null : String(item.nullValue).slice(0, 128),
    };
  });
}

function validateFilters(value) {
  if (!Array.isArray(value)) throw badRequest('filters must be an array');
  if (value.length > 50) throw badRequest('A definition may contain at most 50 filters');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest(`Filter ${index + 1} must be an object`);
    }
    const field = requiredText(item.field, `Filter ${index + 1} field`, 255);
    if (!PATH_RE.test(field)) throw badRequest(`Filter ${index + 1} has an invalid field path`);
    const operator = String(item.operator || '').toLowerCase();
    if (!FILTER_OPERATORS.includes(operator)) throw badRequest(`Unsupported filter operator: ${operator}`);
    if (['in', 'not_in'].includes(operator) && !Array.isArray(item.value)) {
      throw badRequest(`${operator} filters require an array value`);
    }
    return {
      field,
      operator,
      value: ['is_null', 'not_null'].includes(operator)
        ? null
        : Array.isArray(item.value)
          ? item.value.slice(0, 500).map(scalar)
          : scalar(item.value),
    };
  });
}

function validateFormatConfig(format, input) {
  const value = safeDslObject(input, 'formatConfig');
  if (format === 'csv') {
    const delimiter = value.delimiter == null ? ',' : String(value.delimiter);
    if (![',', ';', '\t', '|'].includes(delimiter)) throw badRequest('Unsupported CSV delimiter');
    return {
      delimiter,
      includeHeader: value.includeHeader !== false,
      newline: value.newline === 'crlf' ? 'crlf' : 'lf',
      encoding: 'utf-8',
    };
  }
  if (format === 'xml') {
    const rootElement = String(value.rootElement || 'export');
    const rowElement = String(value.rowElement || 'record');
    if (!XML_NAME_RE.test(rootElement) || !XML_NAME_RE.test(rowElement)) {
      throw badRequest('XML root and row elements must be safe names');
    }
    return { rootElement, rowElement, declaration: value.declaration !== false, encoding: 'utf-8' };
  }
  if (format === 'xlsx') {
    const sheetName = String(value.sheetName || 'Export').slice(0, 31);
    if (!sheetName || /[\\/*?:[\]]/.test(sheetName)) throw badRequest('Invalid XLSX sheet name');
    return { sheetName, freezeHeader: value.freezeHeader !== false, autoFilter: value.autoFilter !== false };
  }
  const dialect = String(value.dialect || 'mysql').toLowerCase();
  if (!['mysql', 'postgresql', 'ansi'].includes(dialect)) throw badRequest('Unsupported SQL dialect');
  const tableName = String(value.tableName || 'workbench_export');
  if (!IDENT_RE.test(tableName)) throw badRequest('SQL tableName must be a safe identifier');
  const batchSize = Number(value.batchSize || 500);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw badRequest('SQL batchSize must be between 1 and 5000');
  }
  return { dialect, tableName, includeCreate: value.includeCreate !== false, batchSize };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function publicDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || null,
    locationId: row.location_id || null,
    sourceType: row.source_type,
    sourceRefId: row.source_ref_id || null,
    sourceKey: row.source_key,
    destinationId: row.destination_id || null,
    format: row.export_format,
    status: row.status,
    currentVersionId: row.current_version_id || null,
    retentionDays: Number(row.retention_days) || 30,
    scheduleCron: row.schedule_cron || null,
    createdBy: row.created_by || null,
    archivedAt: row.archived_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function publicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    definitionId: row.definition_id,
    version: Number(row.version_number),
    status: row.status,
    sourceConfig: parseJson(row.source_config_json, {}),
    mappings: parseJson(row.mapping_json, []),
    filters: parseJson(row.filters_json, []),
    formatConfig: parseJson(row.format_config_json, {}),
    schemaSha256: row.schema_sha256,
    createdBy: row.created_by || null,
    publishedBy: row.published_by || null,
    publishedAt: row.published_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function listDefinitions(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.status) {
    where.push('status=?');
    params.push(String(filters.status).slice(0, 24));
  }
  if (filters.locationId) {
    where.push('location_id=?');
    params.push(String(filters.locationId).slice(0, 128));
  }
  const [rows] = await p.query(
    `SELECT * FROM preservation_export_definitions
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY updated_at DESC`,
    params
  );
  return rows.map(publicDefinition);
}

async function getDefinitionRow(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    'SELECT * FROM preservation_export_definitions WHERE id=? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function getVersionRow(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM preservation_export_versions WHERE id=? LIMIT 1', [id]);
  return rows[0] || null;
}

async function getDefinition(id, pool = null) {
  const p = pool || getPool();
  const definition = await getDefinitionRow(id, p);
  if (!definition) return null;
  const [versions] = await p.query(
    'SELECT * FROM preservation_export_versions WHERE definition_id=? ORDER BY version_number DESC',
    [id]
  );
  return { ...publicDefinition(definition), versions: versions.map(publicVersion) };
}

async function assertDefinitionReferences(definition, pool) {
  if (definition.destinationId) {
    const destination = await getDestination(definition.destinationId, pool);
    if (!destination || !destination.is_enabled) throw notFound('Enabled destination not found');
  }
  if (definition.sourceType === 'integration') {
    const integration = await getIntegration(definition.sourceRefId, pool);
    if (!integration || !integration.is_enabled) throw notFound('Enabled integration source not found');
  } else if (definition.sourceType === 'crm_integration') {
    const [rows] = await pool.query(
      'SELECT id FROM crm_integrations WHERE id=? AND is_enabled=1 LIMIT 1',
      [definition.sourceRefId]
    );
    if (!rows[0]) throw notFound('Enabled CRM integration source not found');
  } else if (definition.sourceType === 'sql_connection') {
    const [rows] = await pool.query(
      'SELECT id FROM sql_connections WHERE id=? AND is_enabled=1 LIMIT 1',
      [definition.sourceRefId]
    );
    if (!rows[0]) throw notFound('Enabled SQL connection source not found');
  }
}

async function createDefinition(input, context = {}, pool = null) {
  const p = pool || getPool();
  const definition = normalizeDefinition(input);
  if (!definition.slug || !definition.name) throw badRequest('slug and name are required');
  const versionPayload = normalizeVersionPayload(input, definition.format);
  await assertDefinitionReferences(definition, p);
  const definitionId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await withTransaction(p, async (connection) => {
    await connection.query(
      `INSERT INTO preservation_export_definitions
         (id,slug,name,description,location_id,source_type,source_ref_id,source_key,
          destination_id,export_format,status,current_version_id,retention_days,schedule_cron,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)`,
      [
        definitionId, definition.slug, definition.name, definition.description,
        definition.locationId, definition.sourceType, definition.sourceRefId,
        definition.sourceKey, definition.destinationId, definition.format, versionId,
        definition.retentionDays, definition.scheduleCron, context.actorId || null,
      ]
    );
    await insertVersion(connection, {
      id: versionId,
      definitionId,
      versionNumber: 1,
      payload: versionPayload,
      createdBy: context.actorId,
    });
    await audit(context, connection, 'preservation.definition.create', 'preservation_definition', definitionId, {
      slug: definition.slug,
      format: definition.format,
      sourceKey: definition.sourceKey,
      version: 1,
    });
  });
  return getDefinition(definitionId, p);
}

async function updateDefinition(id, input, context = {}, pool = null) {
  const p = pool || getPool();
  const existing = await getDefinitionRow(id, p);
  if (!existing) throw notFound('Export definition not found');
  if (existing.status === 'archived') throw conflict('Archived definitions cannot be edited');
  const definition = normalizeDefinition(input, existing);
  await assertDefinitionReferences(definition, p);
  const changesInvalidatePublication =
    definition.sourceType !== existing.source_type ||
    definition.sourceRefId !== existing.source_ref_id ||
    definition.sourceKey !== existing.source_key ||
    definition.format !== existing.export_format;
  if (existing.status === 'published' && changesInvalidatePublication) {
    throw conflict('Create a new draft version before changing a published source or format');
  }
  await p.query(
    `UPDATE preservation_export_definitions
     SET slug=?,name=?,description=?,location_id=?,source_type=?,source_ref_id=?,
         source_key=?,destination_id=?,export_format=?,retention_days=?,schedule_cron=?,
         updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
    [
      definition.slug, definition.name, definition.description, definition.locationId,
      definition.sourceType, definition.sourceRefId, definition.sourceKey,
      definition.destinationId, definition.format, definition.retentionDays,
      definition.scheduleCron, id,
    ]
  );
  await audit(context, p, 'preservation.definition.update', 'preservation_definition', id, {
    slug: definition.slug,
    destinationId: definition.destinationId,
  });
  return getDefinition(id, p);
}

async function createDraftVersion(definitionId, input = {}, context = {}, pool = null) {
  const p = pool || getPool();
  const definition = await getDefinitionRow(definitionId, p);
  if (!definition) throw notFound('Export definition not found');
  if (definition.status === 'archived') throw conflict('Archived definitions cannot be versioned');
  const [drafts] = await p.query(
    `SELECT id FROM preservation_export_versions
     WHERE definition_id=? AND status='draft' LIMIT 1`,
    [definitionId]
  );
  if (drafts[0]) throw conflict('This definition already has an editable draft version');
  const [numbers] = await p.query(
    'SELECT COALESCE(MAX(version_number),0) AS max_version FROM preservation_export_versions WHERE definition_id=?',
    [definitionId]
  );
  const base = definition.current_version_id
    ? await getVersionRow(definition.current_version_id, p)
    : null;
  const payload = normalizeVersionPayload({
    sourceConfig: input.sourceConfig ?? parseJson(base?.source_config_json, {}),
    mappings: input.mappings ?? parseJson(base?.mapping_json, []),
    filters: input.filters ?? parseJson(base?.filters_json, []),
    formatConfig: input.formatConfig ?? parseJson(base?.format_config_json, {}),
  }, definition.export_format);
  const id = crypto.randomUUID();
  const versionNumber = Number(numbers[0]?.max_version || 0) + 1;
  await insertVersion(p, { id, definitionId, versionNumber, payload, createdBy: context.actorId });
  await audit(context, p, 'preservation.version.create', 'preservation_export_version', id, {
    definitionId,
    version: versionNumber,
  });
  return publicVersion(await getVersionRow(id, p));
}

async function updateDraftVersion(id, input, context = {}, pool = null) {
  const p = pool || getPool();
  const version = await getVersionRow(id, p);
  if (!version) throw notFound('Export definition version not found');
  if (version.status !== 'draft') throw conflict('Published and superseded versions are immutable');
  const definition = await getDefinitionRow(version.definition_id, p);
  const payload = normalizeVersionPayload({
    sourceConfig: input.sourceConfig ?? parseJson(version.source_config_json, {}),
    mappings: input.mappings ?? parseJson(version.mapping_json, []),
    filters: input.filters ?? parseJson(version.filters_json, []),
    formatConfig: input.formatConfig ?? parseJson(version.format_config_json, {}),
  }, definition.export_format);
  await p.query(
    `UPDATE preservation_export_versions SET source_config_json=?,mapping_json=?,
       filters_json=?,format_config_json=?,schema_sha256=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND status='draft'`,
    [
      JSON.stringify(payload.sourceConfig), JSON.stringify(payload.mappings),
      JSON.stringify(payload.filters), JSON.stringify(payload.formatConfig),
      payload.schemaSha256, id,
    ]
  );
  await audit(context, p, 'preservation.version.update', 'preservation_export_version', id, {
    definitionId: version.definition_id,
    version: Number(version.version_number),
    schemaSha256: payload.schemaSha256,
  });
  return publicVersion(await getVersionRow(id, p));
}

async function validateDefinitionVersion(definitionId, versionId, pool = null) {
  const p = pool || getPool();
  const definition = await getDefinitionRow(definitionId, p);
  const version = await getVersionRow(versionId, p);
  if (!definition || !version || version.definition_id !== definitionId) {
    throw notFound('Definition version not found');
  }
  await assertDefinitionReferences(normalizeDefinition({}, definition), p);
  const payload = normalizeVersionPayload({
    sourceConfig: parseJson(version.source_config_json, {}),
    mappings: parseJson(version.mapping_json, []),
    filters: parseJson(version.filters_json, []),
    formatConfig: parseJson(version.format_config_json, {}),
  }, definition.export_format);
  return {
    valid: true,
    definitionId,
    versionId,
    version: Number(version.version_number),
    schemaSha256: payload.schemaSha256,
    mappingCount: payload.mappings.length,
    filterCount: payload.filters.length,
  };
}

async function publishVersion(definitionId, versionId, context = {}, pool = null) {
  const p = pool || getPool();
  const validation = await validateDefinitionVersion(definitionId, versionId, p);
  const version = await getVersionRow(versionId, p);
  if (version.status !== 'draft') throw conflict('Only a draft version can be published');
  await withTransaction(p, async (connection) => {
    await connection.query(
      `UPDATE preservation_export_versions
       SET status='superseded',updated_at=CURRENT_TIMESTAMP(3)
       WHERE definition_id=? AND status='published'`,
      [definitionId]
    );
    await connection.query(
      `UPDATE preservation_export_versions
       SET status='published',published_by=?,published_at=CURRENT_TIMESTAMP(3),
           updated_at=CURRENT_TIMESTAMP(3) WHERE id=? AND status='draft'`,
      [context.actorId || null, versionId]
    );
    await connection.query(
      `UPDATE preservation_export_definitions
       SET status='published',current_version_id=?,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=?`,
      [versionId, definitionId]
    );
    await audit(context, connection, 'preservation.version.publish', 'preservation_export_version', versionId, {
      definitionId,
      version: validation.version,
      schemaSha256: validation.schemaSha256,
    });
  });
  return getDefinition(definitionId, p);
}

async function archiveDefinition(id, context = {}, pool = null) {
  const p = pool || getPool();
  const definition = await getDefinitionRow(id, p);
  if (!definition) throw notFound('Export definition not found');
  const [jobs] = await p.query(
    `SELECT id FROM preservation_jobs
     WHERE definition_id=? AND status IN ('queued','extracting','rendering','delivering') LIMIT 1`,
    [id]
  );
  if (jobs[0]) throw conflict('Cannot archive a definition with an active job');
  await p.query(
    `UPDATE preservation_export_definitions
     SET status='archived',archived_by=?,archived_at=CURRENT_TIMESTAMP(3),
         schedule_cron=NULL,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
    [context.actorId || null, id]
  );
  await audit(context, p, 'preservation.definition.archive', 'preservation_definition', id);
  return getDefinition(id, p);
}

async function insertVersion(connection, input) {
  return connection.query(
    `INSERT INTO preservation_export_versions
       (id,definition_id,version_number,status,source_config_json,mapping_json,
        filters_json,format_config_json,schema_sha256,created_by)
     VALUES (?,?,?,'draft',?,?,?,?,?,?)`,
    [
      input.id, input.definitionId, input.versionNumber,
      JSON.stringify(input.payload.sourceConfig), JSON.stringify(input.payload.mappings),
      JSON.stringify(input.payload.filters), JSON.stringify(input.payload.formatConfig),
      input.payload.schemaSha256, input.createdBy || null,
    ]
  );
}

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobType: row.job_type,
    definitionId: row.definition_id || null,
    versionId: row.version_id || null,
    destinationId: row.destination_id || null,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    protectionStatus: row.protection_status || 'unprotected',
    progressPercent: Number(row.progress_percent) || 0,
    workerId: row.worker_id || null,
    leaseExpiresAt: row.lease_expires_at || null,
    attemptCount: Number(row.attempt_count) || 0,
    checkpoint: parseJson(row.checkpoint_json, null),
    watermark: parseJson(row.watermark_json, null),
    requestedBy: row.requested_by || null,
    errorCode: row.error_code || null,
    errorSummary: row.error_summary || null,
    queuedAt: row.queued_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getJobRow(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM preservation_jobs WHERE id=? LIMIT 1', [id]);
  return rows[0] || null;
}

async function listJobs(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.status) {
    where.push('status=?');
    params.push(String(filters.status).slice(0, 24));
  }
  if (filters.definitionId) {
    where.push('definition_id=?');
    params.push(String(filters.definitionId));
  }
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT * FROM preservation_jobs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT ?`,
    params
  );
  return rows.map(publicJob);
}

async function getJob(id, pool = null) {
  const p = pool || getPool();
  const job = await getJobRow(id, p);
  if (!job) return null;
  const [artifacts] = await p.query(
    'SELECT * FROM preservation_artifacts WHERE job_id=? ORDER BY created_at',
    [id]
  );
  const [deliveries] = await p.query(
    'SELECT * FROM preservation_delivery_attempts WHERE job_id=? ORDER BY scheduled_at',
    [id]
  );
  const [manifests] = await p.query(
    `SELECT id,job_id,manifest_version,manifest_sha256,verified_at,created_at
     FROM preservation_job_manifests WHERE job_id=? LIMIT 1`,
    [id]
  );
  return {
    ...publicJob(job),
    artifacts: artifacts.map(publicArtifact),
    deliveries: deliveries.map(publicDelivery),
    manifest: manifests[0] ? {
      id: manifests[0].id,
      version: Number(manifests[0].manifest_version),
      sha256: manifests[0].manifest_sha256,
      verifiedAt: manifests[0].verified_at || null,
      createdAt: manifests[0].created_at,
    } : null,
  };
}

async function createExportJob(input, context = {}, pool = null) {
  const p = pool || getPool();
  const definitionId = requiredText(input.definitionId, 'definitionId', 36);
  const definition = await getDefinitionRow(definitionId, p);
  if (!definition || definition.status !== 'published' || !definition.current_version_id) {
    throw conflict('A published export definition is required');
  }
  const destination = definition.destination_id
    ? await getDestination(definition.destination_id, p)
    : null;
  if (!destination || !destination.is_enabled) throw conflict('An enabled destination is required');
  const idempotencyKey = input.idempotencyKey
    ? requiredText(input.idempotencyKey, 'idempotencyKey', 191)
    : `export:${definitionId}:${crypto.randomUUID()}`;
  const [existing] = await p.query(
    'SELECT * FROM preservation_jobs WHERE idempotency_key=? LIMIT 1',
    [idempotencyKey]
  );
  if (existing[0]) return { job: publicJob(existing[0]), reused: true };
  const id = crypto.randomUUID();
  const retentionDays = Number(definition.retention_days) || 30;
  await p.query(
    `INSERT INTO preservation_jobs
       (id,job_type,definition_id,version_id,destination_id,idempotency_key,status,
        protection_status,requested_by,expires_at)
     VALUES (?,'export',?,?,?,?, 'queued','unprotected',?,
             DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? DAY))`,
    [
      id, definitionId, definition.current_version_id, definition.destination_id,
      idempotencyKey, context.actorId || null, retentionDays,
    ]
  );
  await audit(context, p, 'preservation.job.queue', 'preservation_job', id, {
    definitionId,
    versionId: definition.current_version_id,
    destinationId: definition.destination_id,
  });
  return { job: publicJob(await getJobRow(id, p)), reused: false };
}

async function claimNextJob(workerId, options = {}, pool = null) {
  const p = pool || getPool();
  const leaseSeconds = Math.min(Math.max(Number(options.leaseSeconds) || 120, 30), 900);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [rows] = await p.query(
      `SELECT id FROM preservation_jobs
       WHERE status='queued' AND (lease_expires_at IS NULL OR lease_expires_at<CURRENT_TIMESTAMP(3))
       ORDER BY queued_at ASC LIMIT 1`
    );
    if (!rows[0]) return null;
    const [result] = await p.query(
      `UPDATE preservation_jobs
       SET status='extracting',worker_id=?,lease_expires_at=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL ? SECOND),
           attempt_count=attempt_count+1,started_at=COALESCE(started_at,CURRENT_TIMESTAMP(3)),
           progress_percent=1,error_code=NULL,error_summary=NULL,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=? AND status='queued' AND (lease_expires_at IS NULL OR lease_expires_at<CURRENT_TIMESTAMP(3))`,
      [String(workerId).slice(0, 128), leaseSeconds, rows[0].id]
    );
    if (result.affectedRows) return publicJob(await getJobRow(rows[0].id, p));
  }
  return null;
}

async function heartbeatJob(id, workerId, input = {}, pool = null) {
  const p = pool || getPool();
  const leaseSeconds = Math.min(Math.max(Number(input.leaseSeconds) || 120, 30), 900);
  const progress = Math.min(Math.max(Number(input.progressPercent) || 1, 1), 99);
  const [result] = await p.query(
    `UPDATE preservation_jobs SET progress_percent=?,checkpoint_json=?,watermark_json=?,
       lease_expires_at=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL ? SECOND),
       updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND worker_id=? AND status IN ('extracting','rendering','delivering')`,
    [
      progress,
      input.checkpoint == null ? null : JSON.stringify(safeDslObject(input.checkpoint, 'checkpoint')),
      input.watermark == null ? null : JSON.stringify(safeDslObject(input.watermark, 'watermark')),
      leaseSeconds,
      id,
      String(workerId).slice(0, 128),
    ]
  );
  if (!result.affectedRows) throw conflict('Preservation job lease was lost');
  return publicJob(await getJobRow(id, p));
}

async function recoverExpiredJobs(options = {}, pool = null) {
  const p = pool || getPool();
  const maxAttempts = Math.min(Math.max(Number(options.maxAttempts) || 3, 1), 10);
  await p.query(
    `UPDATE preservation_jobs
     SET status='failed',error_code='WORKER_LEASE_EXHAUSTED',
         error_summary='Worker lease expired too many times',completed_at=CURRENT_TIMESTAMP(3),
         worker_id=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP(3)
     WHERE status IN ('extracting','rendering','delivering')
       AND lease_expires_at<CURRENT_TIMESTAMP(3) AND attempt_count>=?`,
    [maxAttempts]
  );
  const [rows] = await p.query(
    `SELECT id FROM preservation_jobs
     WHERE status IN ('extracting','rendering','delivering')
       AND lease_expires_at<CURRENT_TIMESTAMP(3) AND attempt_count<?`,
    [maxAttempts]
  );
  for (const row of rows) {
    await withTransaction(p, async (connection) => {
      await connection.query(
        `UPDATE preservation_artifacts SET status='abandoned',updated_at=CURRENT_TIMESTAMP(3)
         WHERE job_id=? AND status IN ('staging','verified')`,
        [row.id]
      );
      await connection.query(
        `UPDATE preservation_delivery_attempts SET status='failed',
           error_code='WORKER_LEASE_EXPIRED',error_summary='Worker lease expired',
           completed_at=CURRENT_TIMESTAMP(3)
         WHERE job_id=? AND status IN ('queued','running')`,
        [row.id]
      );
      await connection.query('DELETE FROM preservation_job_manifests WHERE job_id=?', [row.id]);
      await connection.query(
        `UPDATE preservation_jobs SET status='queued',progress_percent=0,checkpoint_json=NULL,
           worker_id=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
        [row.id]
      );
    });
  }
  return { requeued: rows.length };
}

async function transitionJob(id, nextStatus, input = {}, context = {}, pool = null) {
  const p = pool || getPool();
  const job = await getJobRow(id, p);
  if (!job) throw notFound('Preservation job not found');
  if (!JOB_STATES.includes(nextStatus)) throw badRequest('Invalid job status');
  if (!JOB_TRANSITIONS[job.status]?.includes(nextStatus)) {
    throw conflict(`Job cannot transition from ${job.status} to ${nextStatus}`);
  }
  let protectionStatus = job.protection_status || 'unprotected';
  if (nextStatus === 'completed') {
    protectionStatus = await completionProtectionStatus(id, p);
  }
  const progress = terminalStatus(nextStatus)
    ? nextStatus === 'completed' ? 100 : Number(job.progress_percent || 0)
    : Math.min(Math.max(Number(input.progressPercent ?? job.progress_percent) || 0, 0), 99);
  await p.query(
    `UPDATE preservation_jobs SET status=?,protection_status=?,progress_percent=?,
       checkpoint_json=?,watermark_json=?,
       error_code=?,error_summary=?,
       started_at=IF(started_at IS NULL AND ?='extracting',CURRENT_TIMESTAMP(3),started_at),
       completed_at=IF(? IN ('completed','failed','cancelled'),CURRENT_TIMESTAMP(3),completed_at),
       worker_id=IF(? IN ('completed','failed','cancelled'),NULL,worker_id),
       lease_expires_at=IF(? IN ('completed','failed','cancelled'),NULL,lease_expires_at),
       updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND status=?`,
    [
      nextStatus, protectionStatus, progress,
      input.checkpoint == null ? job.checkpoint_json : JSON.stringify(safeDslObject(input.checkpoint, 'checkpoint')),
      input.watermark == null ? job.watermark_json : JSON.stringify(safeDslObject(input.watermark, 'watermark')),
      nextStatus === 'failed' ? String(input.errorCode || 'JOB_FAILED').slice(0, 64) : null,
      nextStatus === 'failed' ? requiredText(input.errorSummary, 'errorSummary', 1000) : null,
      nextStatus, nextStatus, nextStatus, nextStatus, id, job.status,
    ]
  );
  await audit(context, p, `preservation.job.${nextStatus}`, 'preservation_job', id, {
    fromStatus: job.status,
    toStatus: nextStatus,
    protectionStatus,
  });
  return publicJob(await getJobRow(id, p));
}

function terminalStatus(status) {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

async function completionProtectionStatus(jobId, pool) {
  const [artifactCounts] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='verified' AND sha256 IS NOT NULL THEN 1 ELSE 0 END) AS verified
     FROM preservation_artifacts WHERE job_id=? AND status NOT IN ('abandoned','deleted')`,
    [jobId]
  );
  const total = Number(artifactCounts[0]?.total || 0);
  if (!total || Number(artifactCounts[0]?.verified || 0) !== total) {
    throw conflict('All job artifacts must be checksum-verified before completion');
  }
  const [deliveryCounts] = await pool.query(
    `SELECT COUNT(DISTINCT a.id) AS delivered,
            SUM(CASE WHEN d.is_protection_target=1 THEN 1 ELSE 0 END) AS protected_deliveries
     FROM preservation_artifacts a
     INNER JOIN preservation_delivery_attempts x
       ON x.artifact_id=a.id AND x.status='succeeded'
     INNER JOIN preservation_destinations d ON d.id=x.destination_id
     WHERE a.job_id=?`,
    [jobId]
  );
  if (Number(deliveryCounts[0]?.delivered || 0) !== total) {
    throw conflict('Every verified artifact requires a successful delivery before completion');
  }
  return Number(deliveryCounts[0]?.protected_deliveries || 0) > 0 ? 'verified_off_instance' : 'local_only';
}

function publicArtifact(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    logicalName: row.logical_name,
    mediaType: row.media_type,
    format: row.export_format,
    storageUri: row.storage_uri || null,
    byteCount: Number(row.byte_count) || 0,
    recordCount: Number(row.record_count) || 0,
    rejectedCount: Number(row.rejected_count) || 0,
    sha256: row.sha256 || null,
    isEncrypted: Boolean(row.is_encrypted),
    encryption: parseJson(row.encryption_json, null),
    status: row.status,
    verifiedAt: row.verified_at || null,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function registerArtifact(input, context = {}, pool = null) {
  const p = pool || getPool();
  const job = await getJobRow(input.jobId, p);
  if (!job) throw notFound('Preservation job not found');
  if (!['rendering', 'delivering'].includes(job.status)) {
    throw conflict('Artifacts can only be registered while rendering or delivering');
  }
  if (!EXPORT_FORMATS.includes(String(input.format))) throw badRequest('Unsupported artifact format');
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO preservation_artifacts
       (id,job_id,logical_name,media_type,export_format,storage_uri,byte_count,
        record_count,rejected_count,is_encrypted,encryption_json,status,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'staging',?)`,
    [
      id, job.id, requiredText(input.logicalName, 'logicalName', 255),
      requiredText(input.mediaType, 'mediaType', 128), input.format,
      input.storageUri ? String(input.storageUri).slice(0, 1000) : null,
      Math.max(Number(input.byteCount) || 0, 0),
      Math.max(Number(input.recordCount) || 0, 0),
      Math.max(Number(input.rejectedCount) || 0, 0),
      input.isEncrypted === false ? 0 : 1,
      input.encryption ? JSON.stringify(safeDslObject(input.encryption, 'encryption')) : null,
      job.expires_at,
    ]
  );
  await audit(context, p, 'preservation.artifact.register', 'preservation_artifact', id, {
    jobId: job.id,
    format: input.format,
  });
  const [rows] = await p.query('SELECT * FROM preservation_artifacts WHERE id=?', [id]);
  return publicArtifact(rows[0]);
}

async function verifyArtifact(id, input, context = {}, pool = null) {
  const p = pool || getPool();
  const checksum = String(input.sha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(checksum)) throw badRequest('A valid SHA-256 checksum is required');
  const [rows] = await p.query('SELECT * FROM preservation_artifacts WHERE id=? LIMIT 1', [id]);
  if (!rows[0]) throw notFound('Artifact not found');
  if (rows[0].status !== 'staging') throw conflict('Only staging artifacts can be verified');
  await p.query(
    `UPDATE preservation_artifacts SET sha256=?,byte_count=?,record_count=?,rejected_count=?,
       status='verified',verified_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND status='staging'`,
    [
      checksum, Math.max(Number(input.byteCount ?? rows[0].byte_count) || 0, 0),
      Math.max(Number(input.recordCount ?? rows[0].record_count) || 0, 0),
      Math.max(Number(input.rejectedCount ?? rows[0].rejected_count) || 0, 0), id,
    ]
  );
  await audit(context, p, 'preservation.artifact.verify', 'preservation_artifact', id, {
    jobId: rows[0].job_id,
    sha256: checksum,
  });
  const [updated] = await p.query('SELECT * FROM preservation_artifacts WHERE id=?', [id]);
  return publicArtifact(updated[0]);
}

async function getArtifactRow(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM preservation_artifacts WHERE id=? LIMIT 1', [id]);
  return rows[0] || null;
}

async function createManifest(jobId, input, context = {}, pool = null) {
  const p = pool || getPool();
  const job = await getJob(jobId, p);
  if (!job) throw notFound('Preservation job not found');
  const activeArtifacts = job.artifacts.filter((artifact) => !['abandoned', 'deleted'].includes(artifact.status));
  if (!activeArtifacts.length || activeArtifacts.some((artifact) => artifact.status !== 'verified')) {
    throw conflict('Verified artifacts are required before creating the manifest');
  }
  const definition = job.definitionId ? await getDefinitionRow(job.definitionId, p) : null;
  const version = job.versionId ? await getVersionRow(job.versionId, p) : null;
  const manifest = {
    manifestVersion: 1,
    instanceId: requiredText(input.instanceId, 'instanceId', 191),
    job: {
      id: job.id,
      type: job.jobType,
      definitionId: job.definitionId,
      versionId: job.versionId,
      destinationId: job.destinationId,
      queuedAt: job.queuedAt,
    },
    definition: definition ? {
      slug: definition.slug,
      sourceType: definition.source_type,
      sourceKey: definition.source_key,
      locationId: definition.location_id || null,
      format: definition.export_format,
      schemaSha256: version?.schema_sha256 || null,
      version: Number(version?.version_number || 0),
    } : null,
    watermarks: job.watermark || {},
    artifacts: activeArtifacts.map((artifact) => ({
      id: artifact.id,
      logicalName: artifact.logicalName,
      mediaType: artifact.mediaType,
      format: artifact.format,
      byteCount: artifact.byteCount,
      recordCount: artifact.recordCount,
      rejectedCount: artifact.rejectedCount,
      sha256: artifact.sha256,
      encrypted: artifact.isEncrypted,
    })),
    generatedAt: new Date().toISOString(),
    application: safeDslObject(input.application || {}, 'application'),
    warnings: Array.isArray(input.warnings) ? input.warnings.slice(0, 100).map((item) => scalar(item)) : [],
  };
  const encoded = stableStringify(manifest);
  const checksum = crypto.createHash('sha256').update(encoded).digest('hex');
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO preservation_job_manifests
       (id,job_id,manifest_version,manifest_json,manifest_sha256)
     VALUES (?,?,1,?,?)`,
    [id, jobId, JSON.stringify(manifest), checksum]
  );
  await audit(context, p, 'preservation.manifest.create', 'preservation_manifest', id, {
    jobId,
    sha256: checksum,
    artifacts: manifest.artifacts.length,
  });
  return { id, jobId, version: 1, manifest, sha256: checksum, verifiedAt: null };
}

async function verifyManifest(jobId, checksum, context = {}, pool = null) {
  const p = pool || getPool();
  const value = String(checksum || '').toLowerCase();
  if (!SHA256_RE.test(value)) throw badRequest('A valid manifest SHA-256 checksum is required');
  const [result] = await p.query(
    `UPDATE preservation_job_manifests SET verified_at=CURRENT_TIMESTAMP(3)
     WHERE job_id=? AND manifest_sha256=? AND verified_at IS NULL`,
    [jobId, value]
  );
  if (!result.affectedRows) throw conflict('Manifest checksum did not match or was already verified');
  await audit(context, p, 'preservation.manifest.verify', 'preservation_job', jobId, { sha256: value });
  return { jobId, sha256: value, verified: true };
}

function publicDelivery(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    artifactId: row.artifact_id,
    destinationId: row.destination_id,
    attemptNumber: Number(row.attempt_number),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    remoteReference: row.remote_reference || null,
    byteCount: row.byte_count == null ? null : Number(row.byte_count),
    sha256: row.sha256 || null,
    errorCode: row.error_code || null,
    errorSummary: row.error_summary || null,
    scheduledAt: row.scheduled_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
  };
}

async function createDeliveryAttempt(input, context = {}, pool = null) {
  const p = pool || getPool();
  const [artifacts] = await p.query(
    `SELECT * FROM preservation_artifacts
     WHERE id=? AND job_id=? AND status='verified' LIMIT 1`,
    [input.artifactId, input.jobId]
  );
  if (!artifacts[0]) throw conflict('A verified job artifact is required');
  const destination = await getDestination(input.destinationId, p);
  if (!destination || !destination.is_enabled) throw notFound('Enabled destination not found');
  const [attempts] = await p.query(
    `SELECT COALESCE(MAX(attempt_number),0) AS max_attempt
     FROM preservation_delivery_attempts WHERE artifact_id=? AND destination_id=?`,
    [input.artifactId, input.destinationId]
  );
  const attemptNumber = Number(attempts[0]?.max_attempt || 0) + 1;
  const id = crypto.randomUUID();
  const idempotencyKey = `delivery:${input.artifactId}:${input.destinationId}:${attemptNumber}`;
  await p.query(
    `INSERT INTO preservation_delivery_attempts
       (id,job_id,artifact_id,destination_id,attempt_number,idempotency_key,status)
     VALUES (?,?,?,?,?,?,'queued')`,
    [id, input.jobId, input.artifactId, input.destinationId, attemptNumber, idempotencyKey]
  );
  await audit(context, p, 'preservation.delivery.queue', 'preservation_delivery', id, {
    jobId: input.jobId,
    artifactId: input.artifactId,
    destinationId: input.destinationId,
    attemptNumber,
  });
  const [rows] = await p.query('SELECT * FROM preservation_delivery_attempts WHERE id=?', [id]);
  return publicDelivery(rows[0]);
}

async function completeDeliveryAttempt(id, input, context = {}, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    'SELECT * FROM preservation_delivery_attempts WHERE id=? LIMIT 1',
    [id]
  );
  const delivery = rows[0];
  if (!delivery) throw notFound('Delivery attempt not found');
  if (!['queued', 'running'].includes(delivery.status)) throw conflict('Delivery attempt is already terminal');
  const succeeded = input.succeeded === true;
  const checksum = input.sha256 == null ? null : String(input.sha256).toLowerCase();
  if (succeeded && !SHA256_RE.test(checksum || '')) {
    throw badRequest('Successful delivery requires the verified remote SHA-256 checksum');
  }
  await p.query(
    `UPDATE preservation_delivery_attempts
     SET status=?,remote_reference=?,byte_count=?,sha256=?,error_code=?,error_summary=?,
         started_at=COALESCE(started_at,CURRENT_TIMESTAMP(3)),
         completed_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
    [
      succeeded ? 'succeeded' : 'failed',
      input.remoteReference ? String(input.remoteReference).slice(0, 1000) : null,
      input.byteCount == null ? null : Math.max(Number(input.byteCount) || 0, 0),
      checksum,
      succeeded ? null : String(input.errorCode || 'DELIVERY_FAILED').slice(0, 64),
      succeeded ? null : requiredText(input.errorSummary, 'errorSummary', 1000),
      id,
    ]
  );
  await audit(context, p, `preservation.delivery.${succeeded ? 'succeed' : 'fail'}`,
    'preservation_delivery', id, {
      jobId: delivery.job_id,
      artifactId: delivery.artifact_id,
      destinationId: delivery.destination_id,
    });
  const [updated] = await p.query('SELECT * FROM preservation_delivery_attempts WHERE id=?', [id]);
  return publicDelivery(updated[0]);
}

async function withTransaction(pool, fn) {
  if (!pool.getConnection) return fn(pool);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function audit(context, pool, action, entityType, entityId, details = {}) {
  return recordPreservationAudit({
    requestId: context.requestId,
    actorType: context.actorType,
    actorId: context.actorId,
    action,
    entityType,
    entityId,
    details,
  }, pool);
}

module.exports = {
  EXPORT_FORMATS,
  SOURCE_TYPES,
  SOURCE_CATALOG,
  VALUE_TYPES,
  TRANSFORMS,
  FILTER_OPERATORS,
  JOB_TYPES,
  JOB_STATES,
  JOB_TRANSITIONS,
  normalizeDefinition,
  normalizeVersionPayload,
  validateMappings,
  validateFilters,
  validateFormatConfig,
  stableStringify,
  publicDefinition,
  publicVersion,
  listDefinitions,
  getDefinition,
  createDefinition,
  updateDefinition,
  createDraftVersion,
  updateDraftVersion,
  validateDefinitionVersion,
  publishVersion,
  archiveDefinition,
  publicJob,
  listJobs,
  getJob,
  createExportJob,
  claimNextJob,
  heartbeatJob,
  recoverExpiredJobs,
  transitionJob,
  registerArtifact,
  verifyArtifact,
  getArtifactRow,
  createManifest,
  verifyManifest,
  createDeliveryAttempt,
  completeDeliveryAttempt,
};
