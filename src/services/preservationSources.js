const { getPool } = require('../db/pool');
const { getConnectionById, getDataPool, quoteIdent, assertIdent } = require('./sqlConnections');
const { getGrant } = require('./sqlGrants');
const {
  getIntegration,
  resolveSecret,
  validateHttpsUrl,
} = require('./integrationManagement');

const CATALOG_DATASETS = Object.freeze({
  customer_directory: dataset('users', 'id', 'locationId', [
    'id', 'locationId', 'username', 'role', 'crmUserId', 'crmUserName',
    'email', 'phone', 'createdAt',
  ]),
  leads_contacts: dataset('leads', 'id', 'locationId', [
    'id', 'locationId', 'serviceType', 'status', 'assignedTo', 'contactData',
    'dateAdded', 'lastContacted', 'dncStatus', 'dncCheckedAt', 'dncSource',
    'phoneMarketingStatus', 'emailMarketingStatus', 'smsMarketingStatus',
  ], leadCanonical),
  appointments_outcomes: dataset('appointments', 'id', 'locationId', [
    'id', 'locationId', 'leadId', 'userId', 'calendarId', 'externalEventId',
    'externalContactId', 'source', 'appointmentDate', 'status', 'syncedAt', 'createdAt',
  ]),
  dialer_operations: dataset('dialer_work_sessions', 'id', 'locationId', [
    'id', 'locationId', 'userId', 'weekStart', 'startedAt', 'endedAt',
    'durationSeconds', 'status', 'source', 'createdAt', 'updatedAt',
  ]),
  schedules_routing: dataset('user_schedules', 'userId', 'locationId', [
    'userId', 'locationId', 'scheduleData', 'updatedAt',
  ]),
  automation_definitions: dataset('song_scripts', 'id', 'location_id', [
    'id', 'api_key_id', 'location_id', 'service_type', 'language_code', 'name',
    'description', 'status', 'draft_revision', 'published_version_id', 'created_at', 'updated_at',
  ]),
  automation_activity: dataset('hawk_executions', 'id', 'location_id', [
    'id', 'flow_id', 'version_id', 'api_key_id', 'location_id', 'data_source_slug',
    'trigger_type', 'status', 'mode', 'steps_total', 'steps_completed', 'started_at',
    'completed_at', 'created_at',
  ]),
  eagle_analytics: dataset('eagle_lead_facts', 'id', 'location_id', [
    'id', 'snapshot_id', 'integration_id', 'location_id', 'external_contact_id',
    'lead_id', 'full_name', 'email', 'phone', 'city', 'state_code', 'postal_code',
    'country', 'marketing_source', 'campaign', 'medium', 'service_type',
    'crm_disposition', 'crm_assigned_to', 'dial_status', 'dial_assigned_to',
    'dnc_status', 'tags_json', 'crm_date_added', 'crm_updated_at', 'captured_at',
  ]),
  configuration_package: dataset('app_settings', 'setting_key', null, [
    'setting_key', 'setting_value', 'updated_at',
  ], configurationCanonical),
});

const CONFIG_SECRET_RE = /(?:secret|password|token|credential|session|private|api[_-]?key)/i;

function dataset(table, primaryKey, locationColumn, columns, canonical = rowCanonical) {
  return Object.freeze({ table, primaryKey, locationColumn, columns: Object.freeze(columns), canonical });
}

function rowCanonical(row) {
  return { ...row, record: row };
}

function leadCanonical(row) {
  const contact = parseJson(row.contactData, {});
  return {
    ...row,
    record: row,
    lead: row,
    contact: { id: row.id, locationId: row.locationId, ...contact },
  };
}

function configurationCanonical(row) {
  if (CONFIG_SECRET_RE.test(row.setting_key || '')) return null;
  return { ...row, record: row, setting: { key: row.setting_key, value: row.setting_value } };
}

async function createSourceStream(definition, version, options = {}) {
  const pool = options.pool || getPool();
  const chunkSize = options.chunkSize || 500;
  const maxRecords = options.maxRecords || 1000000;
  if (definition.sourceType === 'catalog') {
    return catalogStream(definition, version, { pool, chunkSize, maxRecords });
  }
  if (definition.sourceType === 'crm_integration') {
    return crmStream(definition, version, { pool, chunkSize, maxRecords });
  }
  if (definition.sourceType === 'sql_connection') {
    return sqlStream(definition, version, { pool, chunkSize, maxRecords });
  }
  if (definition.sourceType === 'integration') {
    const registry = await getIntegration(definition.sourceRefId, pool);
    if (!registry || !registry.is_enabled) throw sourceError('SOURCE_DISABLED', 'Registered source is disabled');
    if (registry.adapter_type === 'http_api') {
      return httpStream(definition, version, registry, { maxRecords });
    }
    if (registry.source_ref_type === 'crm_integration') {
      return crmStream({ ...definition, sourceRefId: registry.source_ref_id }, version,
        { pool, chunkSize, maxRecords });
    }
    if (registry.source_ref_type === 'sql_connection') {
      return sqlStream({ ...definition, sourceRefId: registry.source_ref_id }, version,
        { pool, chunkSize, maxRecords });
    }
    return catalogStream(definition, version, { pool, chunkSize, maxRecords });
  }
  throw sourceError('SOURCE_UNSUPPORTED', 'Unsupported preservation source');
}

async function catalogStream(definition, version, options) {
  const spec = CATALOG_DATASETS[definition.sourceKey];
  if (!spec) throw sourceError('SOURCE_UNSUPPORTED', 'Source catalog dataset is not implemented');
  if (spec.locationColumn && !definition.locationId) {
    throw sourceError('SCOPE_REQUIRED', 'A locationId is required for this preservation source');
  }
  const scope = spec.locationColumn ? {
    sql: `${quoteIdent(spec.locationColumn)} = ?`,
    params: [definition.locationId],
  } : { sql: '1=1', params: [] };
  const maxCursor = await maximumCursor(options.pool, spec, scope);
  return {
    watermark: { type: 'primary_key', maximum: maxCursor, capturedAt: new Date().toISOString() },
    records: keysetRecords({
      pool: options.pool,
      spec,
      scope,
      maximum: maxCursor,
      chunkSize: options.chunkSize,
      maxRecords: options.maxRecords,
    }),
  };
}

async function maximumCursor(pool, spec, scope) {
  const [rows] = await pool.query(
    `SELECT MAX(${quoteIdent(spec.primaryKey)}) AS maximum
     FROM ${quoteIdent(spec.table)} WHERE ${scope.sql}`,
    scope.params
  );
  return rows[0]?.maximum ?? null;
}

async function* keysetRecords({ pool, spec, scope, maximum, chunkSize, maxRecords }) {
  if (maximum == null) return;
  let cursor = null;
  let emitted = 0;
  while (emitted < maxRecords) {
    const params = [...scope.params];
    const cursorSql = cursor == null ? '' : ` AND ${quoteIdent(spec.primaryKey)} > ?`;
    if (cursor != null) params.push(cursor);
    params.push(maximum, Math.min(chunkSize, maxRecords - emitted));
    const [rows] = await pool.query(
      `SELECT ${spec.columns.map(quoteIdent).join(',')}
       FROM ${quoteIdent(spec.table)}
       WHERE ${scope.sql}${cursorSql} AND ${quoteIdent(spec.primaryKey)} <= ?
       ORDER BY ${quoteIdent(spec.primaryKey)} ASC LIMIT ?`,
      params
    );
    if (!rows.length) return;
    for (const row of rows) {
      cursor = row[spec.primaryKey];
      const canonical = spec.canonical(row);
      if (canonical) {
        emitted += 1;
        yield { record: canonical, cursor, emitted };
      }
    }
    if (rows.length < chunkSize) return;
  }
}

async function crmStream(definition, version, options) {
  if (!definition.locationId) throw sourceError('SCOPE_REQUIRED', 'locationId is required for CRM preservation');
  const integrationId = definition.sourceRefId;
  const [integrations] = await options.pool.query(
    'SELECT id FROM crm_integrations WHERE id=? AND is_enabled=1 LIMIT 1',
    [integrationId]
  );
  if (!integrations[0]) throw sourceError('SOURCE_DISABLED', 'CRM integration is disabled or missing');
  const [maximumRows] = await options.pool.query(
    `SELECT MAX(external_record_id) AS maximum FROM crm_contact_records
     WHERE integration_id=? AND location_id=? AND is_current=1`,
    [integrationId, definition.locationId]
  );
  const maximum = maximumRows[0]?.maximum ?? null;
  async function* records() {
    if (maximum == null) return;
    let cursor = '';
    let emitted = 0;
    while (emitted < options.maxRecords) {
      const [rows] = await options.pool.query(
        `SELECT integration_id,external_record_id,location_id,lead_id,payload_hash,
                payload_json,external_updated_at,first_seen_at,last_seen_at
         FROM crm_contact_records
         WHERE integration_id=? AND location_id=? AND is_current=1
           AND external_record_id>? AND external_record_id<=?
         ORDER BY external_record_id ASC LIMIT ?`,
        [
          integrationId,
          definition.locationId,
          cursor,
          maximum,
          Math.min(options.chunkSize, options.maxRecords - emitted),
        ]
      );
      if (!rows.length) return;
      for (const row of rows) {
        cursor = row.external_record_id;
        emitted += 1;
        const payload = parseJson(row.payload_json, {});
        yield {
          record: {
            ...payload,
            contact: { id: row.external_record_id, ...payload },
            record: {
              integrationId: row.integration_id,
              externalRecordId: row.external_record_id,
              locationId: row.location_id,
              leadId: row.lead_id,
              payloadHash: row.payload_hash,
              externalUpdatedAt: row.external_updated_at,
              firstSeenAt: row.first_seen_at,
              lastSeenAt: row.last_seen_at,
            },
          },
          cursor,
          emitted,
        };
      }
      if (rows.length < options.chunkSize) return;
    }
  }
  return {
    watermark: { type: 'external_record_id', maximum, capturedAt: new Date().toISOString() },
    records: records(),
  };
}

async function sqlStream(definition, version, options) {
  const config = version.sourceConfig || {};
  if (!definition.locationId) throw sourceError('SCOPE_REQUIRED', 'locationId is required for external SQL preservation');
  const apiKeyId = String(config.apiKeyId || '');
  const table = assertIdent(config.table, 'source table');
  const locationColumn = assertIdent(config.locationColumn, 'location scope column');
  if (!apiKeyId) throw sourceError('GRANT_REQUIRED', 'sourceConfig.apiKeyId is required');
  const grant = await getGrant(definition.sourceRefId, apiKeyId, options.pool);
  if (!grant) throw sourceError('GRANT_REQUIRED', 'No SQL connection grant exists for this API key');
  const tableGrant = grant.tables.find((item) => item.tableName === table && item.allowSelect);
  if (!tableGrant) throw sourceError('GRANT_REQUIRED', 'The selected external table is not granted for read');
  const connection = await getConnectionById(definition.sourceRefId, options.pool);
  if (!connection || !connection.is_enabled) throw sourceError('SOURCE_DISABLED', 'SQL connection is disabled');
  const primaryKey = assertIdent(tableGrant.primaryKey || 'id', 'primary key');
  const mappedColumns = version.mappings.map((mapping) =>
    String(mapping.source).replace(/^record\./, '').split('.')[0]);
  const selectedColumns = Array.isArray(config.columns) ? config.columns : mappedColumns;
  const requested = [...new Set([primaryKey, locationColumn, ...selectedColumns])]
    .map((column) => assertIdent(column, 'source column'));
  const allowed = tableGrant.allowedColumns;
  if (allowed && requested.some((column) => !allowed.includes(column))) {
    throw sourceError('COLUMN_DENIED', 'One or more mapped columns are outside the SQL grant');
  }
  const dataPool = await getDataPool(connection);
  const spec = dataset(table, primaryKey, locationColumn, requested);
  const scope = { sql: `${quoteIdent(locationColumn)} = ?`, params: [definition.locationId] };
  const maximum = await maximumCursor(dataPool, spec, scope);
  return {
    watermark: { type: 'external_primary_key', maximum, capturedAt: new Date().toISOString() },
    records: keysetRecords({
      pool: dataPool,
      spec,
      scope,
      maximum,
      chunkSize: options.chunkSize,
      maxRecords: options.maxRecords,
    }),
  };
}

async function httpStream(definition, version, registry, options) {
  const config = { ...parseJson(registry.config_json, {}), ...(version.sourceConfig || {}) };
  const relativePath = String(config.path || '/').trim();
  const origin = new URL(validateHttpsUrl(registry.base_url));
  const firstUrl = new URL(relativePath, origin);
  if (firstUrl.origin !== origin.origin) throw sourceError('URL_DENIED', 'HTTP source path must remain on its registered origin');
  const credential = registry.credential_id ? await resolveSecret(registry.credential_id) : null;
  const headers = { Accept: 'application/json', ...publicHeaders(config.headers || {}) };
  applyCredential(headers, credential);
  const recordsPath = String(config.recordsPath || 'data');
  const nextCursorPath = String(config.nextCursorPath || 'meta.nextCursor');
  const cursorParam = String(config.cursorParam || 'cursor');
  const pageSizeParam = String(config.pageSizeParam || 'limit');
  const pageSize = Math.min(Math.max(Number(config.pageSize) || 250, 1), 1000);
  async function* records() {
    let cursor = null;
    let emitted = 0;
    let page = 0;
    while (emitted < options.maxRecords && page < 10000) {
      page += 1;
      const url = new URL(firstUrl);
      url.searchParams.set(pageSizeParam, String(pageSize));
      if (cursor != null) url.searchParams.set(cursorParam, String(cursor));
      const response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw sourceError('HTTP_SOURCE_FAILED', `HTTP source returned ${response.status}`);
      const payload = await response.json();
      const rows = getPath(payload, recordsPath);
      if (!Array.isArray(rows)) throw sourceError('HTTP_RECORDS_INVALID', 'HTTP recordsPath did not resolve to an array');
      for (const row of rows) {
        emitted += 1;
        yield { record: rowCanonical(row), cursor: cursor ?? page, emitted };
        if (emitted >= options.maxRecords) return;
      }
      const next = getPath(payload, nextCursorPath);
      if (next == null || next === '' || !rows.length || String(next) === String(cursor)) return;
      cursor = next;
    }
  }
  return {
    watermark: { type: 'http_started_at', capturedAt: new Date().toISOString() },
    records: records(),
  };
}

function publicHeaders(input) {
  const headers = {};
  for (const [name, value] of Object.entries(input || {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) ||
        /^(?:authorization|cookie|proxy-authorization)$/i.test(name)) {
      throw sourceError('HEADER_DENIED', 'Restricted HTTP source header');
    }
    headers[name] = String(value).slice(0, 1000);
  }
  return headers;
}

function applyCredential(headers, credential) {
  if (!credential) return;
  if (credential.kind === 'bearer_token') headers.Authorization = `Bearer ${credential.value}`;
  else if (credential.kind === 'api_key') headers['X-API-Key'] = credential.value;
  else if (credential.kind === 'basic_auth') {
    const value = credential.value || {};
    headers.Authorization = `Basic ${Buffer.from(`${value.username || ''}:${value.password || ''}`).toString('base64')}`;
  } else {
    throw sourceError('CREDENTIAL_UNSUPPORTED', 'Credential kind is not supported by the HTTP source adapter');
  }
}

function mapAndFilterStream(records, version, stats = {}) {
  stats.read = 0;
  stats.written = 0;
  stats.rejected = 0;
  stats.filtered = 0;
  stats.lastCursor = null;
  async function* output() {
    for await (const item of records) {
      stats.read += 1;
      stats.lastCursor = item.cursor;
      if (stats.onProgress && stats.read % (stats.progressEvery || 500) === 0) {
        await stats.onProgress(stats);
      }
      if (!matchesFilters(item.record, version.filters || [])) {
        stats.filtered += 1;
        continue;
      }
      try {
        const mapped = {};
        for (const mapping of version.mappings) {
          let value = getPath(item.record, mapping.source);
          if (value == null || value === '') value = mapping.default;
          if (mapping.required && (value == null || value === '')) {
            throw new Error(`Required field missing: ${mapping.source}`);
          }
          mapped[mapping.target] = coerceValue(transformValue(value, mapping.transform), mapping.type);
        }
        stats.written += 1;
        yield mapped;
      } catch {
        stats.rejected += 1;
      }
    }
  }
  return output();
}

function matchesFilters(record, filters) {
  return filters.every((filter) => {
    const actual = getPath(record, filter.field);
    const expected = filter.value;
    switch (filter.operator) {
      case 'eq': return scalarCompare(actual, expected) === 0;
      case 'ne': return scalarCompare(actual, expected) !== 0;
      case 'gt': return scalarCompare(actual, expected) > 0;
      case 'gte': return scalarCompare(actual, expected) >= 0;
      case 'lt': return scalarCompare(actual, expected) < 0;
      case 'lte': return scalarCompare(actual, expected) <= 0;
      case 'contains': return String(actual ?? '').includes(String(expected ?? ''));
      case 'in': return expected.some((item) => scalarCompare(actual, item) === 0);
      case 'not_in': return !expected.some((item) => scalarCompare(actual, item) === 0);
      case 'is_null': return actual == null;
      case 'not_null': return actual != null;
      default: return false;
    }
  });
}

function scalarCompare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function transformValue(value, transform) {
  if (value == null) return null;
  if (transform === 'trim') return String(value).trim();
  if (transform === 'lowercase') return String(value).toLowerCase();
  if (transform === 'uppercase') return String(value).toUpperCase();
  return value;
}

function coerceValue(value, type) {
  if (value == null) return null;
  if (type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (type === 'boolean') return value === true || value === 1 || /^(?:true|1|yes)$/i.test(String(value));
  if (type === 'json') return typeof value === 'string' ? parseJson(value, value) : value;
  if (type === 'date' || type === 'datetime') {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? null
      : type === 'date' ? date.toISOString().slice(0, 10) : date.toISOString();
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function getPath(value, path) {
  return String(path || '').replace(/\[(\d+)\]/g, '.$1').split('.')
    .filter(Boolean).reduce((current, part) => current == null ? undefined : current[part], value);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sourceError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  CATALOG_DATASETS,
  createSourceStream,
  mapAndFilterStream,
  matchesFilters,
  getPath,
  coerceValue,
};
