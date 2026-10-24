const crypto = require('crypto');
const net = require('net');
const { getPool } = require('../db/pool');
const { getSecretBoxKey } = require('../config');
const { encryptSecret, decryptSecret } = require('./secretBox');
const { recordPreservationAudit } = require('./preservationAudit');

const SLUG_RE = /^[a-z][a-z0-9_-]{1,62}$/;
const SECRET_KINDS = Object.freeze([
  'api_key',
  'bearer_token',
  'basic_auth',
  'oauth_client',
  'aws_credentials',
  'ssh_key',
  'connection_json',
]);
const ADAPTER_TYPES = Object.freeze(['workbench', 'crm', 'mysql', 'http_api']);
const SOURCE_REF_TYPES = Object.freeze(['core', 'crm_integration', 'sql_connection', 'external']);
const DESTINATION_TYPES = Object.freeze(['s3', 'sftp', 'https', 'local_staging']);
const SECRET_CONFIG_KEY_RE =
  /(?:secret|password|authorization|credential|token|private[_-]?key|access[_-]?key|api[_-]?key)/i;
const MAX_CONFIG_BYTES = 64 * 1024;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function assertSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw badRequest('slug must be 2-63 characters and contain only letters, numbers, _ or -');
  }
  return slug;
}

function requiredText(value, label, max = 128) {
  const text = String(value || '').trim();
  if (!text) throw badRequest(`${label} is required`);
  return text.slice(0, max);
}

function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    throw badRequest('Configuration must be valid JSON');
  }
}

function validatePublicConfig(value) {
  const config = parseJson(value, {});
  if (Array.isArray(config)) throw badRequest('Configuration must be a JSON object');
  const encoded = JSON.stringify(config);
  if (Buffer.byteLength(encoded) > MAX_CONFIG_BYTES) {
    throw badRequest('Configuration exceeds 64 KB');
  }
  walkConfig(config);
  return config;
}

function walkConfig(value, depth = 0) {
  if (depth > 8) throw badRequest('Configuration nesting is too deep');
  if (Array.isArray(value)) {
    value.forEach((item) => walkConfig(item, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    if (SECRET_CONFIG_KEY_RE.test(key)) {
      throw badRequest(`Secret-like configuration key "${key}" must use a credential reference`);
    }
    walkConfig(item, depth + 1);
  });
}

function assertPublicHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) throw badRequest('Destination host is required');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  ) {
    throw badRequest('Loopback, local, and metadata hosts are blocked');
  }
  const version = net.isIP(host);
  if (version === 4) {
    const octets = host.split('.').map(Number);
    const blocked =
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      octets[0] === 0;
    if (blocked) throw badRequest('Private, loopback, link-local, and metadata addresses are blocked');
  } else if (
    version === 6 &&
    (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host))
  ) {
    throw badRequest('Private, loopback, and link-local addresses are blocked');
  }
  return host;
}

function validateHttpsUrl(value, label = 'baseUrl') {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw badRequest(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:') throw badRequest(`${label} must use HTTPS`);
  if (url.username || url.password) throw badRequest(`${label} must not contain credentials`);
  assertPublicHost(url.hostname);
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeSecretValue(value) {
  if (value == null || value === '') throw badRequest('secret is required');
  if (typeof value === 'object') {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_CONFIG_BYTES) throw badRequest('Secret payload exceeds 64 KB');
    return encoded;
  }
  const text = String(value);
  if (!text.trim()) throw badRequest('secret is required');
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw badRequest('Secret payload exceeds 64 KB');
  return text;
}

function assertDedicatedVaultKey() {
  if (process.env.NODE_ENV === 'production' && !getSecretBoxKey()) {
    throw Object.assign(
      new Error('SECRET_BOX_KEY is required before storing integration credentials'),
      { status: 503 }
    );
  }
}

function secretHint(value, explicitHint = null) {
  if (explicitHint) return String(explicitHint).replace(/[^A-Za-z0-9_.:@-]/g, '').slice(-16) || null;
  if (typeof value === 'object') {
    const candidate = value.username || value.accessKeyId || value.clientId || value.keyId;
    return candidate ? String(candidate).replace(/[^A-Za-z0-9_.:@-]/g, '').slice(-12) : 'structured';
  }
  const compact = String(value).replace(/\s+/g, '');
  return compact.length >= 4 ? compact.slice(-4) : 'set';
}

function publicSecret(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.secret_kind,
    hint: row.secret_hint || null,
    version: Number(row.version_number) || 1,
    status: row.status,
    hasSecret: Boolean(row.secret_enc),
    createdBy: row.created_by || null,
    rotatedBy: row.rotated_by || null,
    rotatedAt: row.rotated_at || null,
    retiredAt: row.retired_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function listSecrets(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query(
    `SELECT id,name,secret_kind,secret_hint,version_number,status,created_by,
            rotated_by,rotated_at,retired_at,created_at,updated_at
     FROM integration_secrets ORDER BY name`
  );
  return rows.map(publicSecret);
}

async function getSecretRow(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM integration_secrets WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function createSecret(input, context = {}, pool = null) {
  assertDedicatedVaultKey();
  const p = pool || getPool();
  const kind = String(input.kind || input.secretKind || '').trim();
  if (!SECRET_KINDS.includes(kind)) throw badRequest('Unsupported secret kind');
  const name = requiredText(input.name, 'name');
  const secret = normalizeSecretValue(input.secret);
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO integration_secrets
       (id,name,secret_kind,secret_enc,secret_hint,created_by)
     VALUES (?,?,?,?,?,?)`,
    [id, name, kind, encryptSecret(secret), secretHint(input.secret, input.hint), context.actorId || null]
  );
  await audit(context, p, 'integration.secret.create', 'integration_secret', id, {
    name,
    kind,
    hint: secretHint(input.secret, input.hint),
  });
  return publicSecret(await getSecretRow(id, p));
}

async function rotateSecret(id, input, context = {}, pool = null) {
  assertDedicatedVaultKey();
  const p = pool || getPool();
  const existing = await getSecretRow(id, p);
  if (!existing) throw notFound('Credential not found');
  if (existing.status !== 'active') throw conflict('Retired credentials cannot be rotated');
  const secret = normalizeSecretValue(input.secret);
  await p.query(
    `UPDATE integration_secrets
     SET secret_enc=?,secret_hint=?,version_number=version_number+1,
         rotated_by=?,rotated_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=?`,
    [encryptSecret(secret), secretHint(input.secret, input.hint), context.actorId || null, id]
  );
  await audit(context, p, 'integration.secret.rotate', 'integration_secret', id, {
    fromVersion: Number(existing.version_number) || 1,
    toVersion: (Number(existing.version_number) || 1) + 1,
  });
  return publicSecret(await getSecretRow(id, p));
}

async function retireSecret(id, context = {}, pool = null) {
  const p = pool || getPool();
  const existing = await getSecretRow(id, p);
  if (!existing) throw notFound('Credential not found');
  const [usage] = await p.query(
    `SELECT
       (SELECT COUNT(*) FROM integration_registry WHERE credential_id=? AND is_enabled=1) AS integrations,
       (SELECT COUNT(*) FROM preservation_destinations WHERE credential_id=? AND is_enabled=1) AS destinations`,
    [id, id]
  );
  if (Number(usage[0]?.integrations) || Number(usage[0]?.destinations)) {
    throw conflict('Disable or reassign active credential consumers before retirement');
  }
  await p.query(
    `UPDATE integration_secrets
     SET status='retired',retired_by=?,retired_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=?`,
    [context.actorId || null, id]
  );
  await audit(context, p, 'integration.secret.retire', 'integration_secret', id);
  return publicSecret(await getSecretRow(id, p));
}

async function resolveSecret(id, pool = null) {
  const row = await getSecretRow(id, pool);
  if (!row || row.status !== 'active') throw notFound('Active credential not found');
  const plain = decryptSecret(row.secret_enc);
  if (row.secret_kind === 'connection_json' || row.secret_kind === 'aws_credentials' ||
      row.secret_kind === 'oauth_client' || row.secret_kind === 'basic_auth') {
    try {
      return { kind: row.secret_kind, value: JSON.parse(plain), version: Number(row.version_number) };
    } catch {
      throw Object.assign(new Error('Stored credential payload is invalid'), { status: 500 });
    }
  }
  return { kind: row.secret_kind, value: plain, version: Number(row.version_number) };
}

function publicIntegration(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    adapterType: row.adapter_type,
    sourceRefType: row.source_ref_type || null,
    sourceRefId: row.source_ref_id || null,
    baseUrl: row.base_url || null,
    credentialId: row.credential_id || null,
    config: parseStoredJson(row.config_json, {}),
    isEnabled: Boolean(row.is_enabled),
    lastValidationStatus: row.last_validation_status || null,
    lastValidatedAt: row.last_validated_at || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeIntegration(input, existing = {}) {
  const adapterType = input.adapterType == null
    ? existing.adapter_type
    : String(input.adapterType).trim();
  if (!ADAPTER_TYPES.includes(adapterType)) throw badRequest('Unsupported integration adapter type');
  const sourceRefType = input.sourceRefType == null
    ? existing.source_ref_type || (adapterType === 'workbench' ? 'core' : 'external')
    : String(input.sourceRefType).trim();
  if (!SOURCE_REF_TYPES.includes(sourceRefType)) throw badRequest('Unsupported source reference type');
  const baseInput = input.baseUrl === undefined ? existing.base_url : input.baseUrl;
  const baseUrl = adapterType === 'http_api'
    ? validateHttpsUrl(baseInput, 'baseUrl')
    : baseInput ? String(baseInput).trim().slice(0, 1000) : null;
  const sourceRefId = input.sourceRefId === undefined
    ? existing.source_ref_id || null
    : String(input.sourceRefId || '').trim().slice(0, 191) || null;
  if (['crm_integration', 'sql_connection'].includes(sourceRefType) && !sourceRefId) {
    throw badRequest('sourceRefId is required for an existing CRM or SQL connection');
  }
  return {
    slug: input.slug == null ? existing.slug : assertSlug(input.slug),
    name: input.name == null ? existing.name : requiredText(input.name, 'name'),
    adapterType,
    sourceRefType,
    sourceRefId,
    baseUrl,
    credentialId: input.credentialId === undefined
      ? existing.credential_id || null
      : String(input.credentialId || '').trim() || null,
    config: input.config === undefined ? parseStoredJson(existing.config_json, {}) : validatePublicConfig(input.config),
    isEnabled: input.isEnabled === undefined ? existing.is_enabled !== 0 : input.isEnabled !== false,
  };
}

async function assertCredential(id, pool) {
  if (!id) return;
  const row = await getSecretRow(id, pool);
  if (!row || row.status !== 'active') throw notFound('Active credential not found');
}

async function getIntegration(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM integration_registry WHERE id=? LIMIT 1', [id]);
  return rows[0] || null;
}

async function listIntegrations(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM integration_registry ORDER BY name');
  return rows.map(publicIntegration);
}

async function createIntegration(input, context = {}, pool = null) {
  const p = pool || getPool();
  const normalized = normalizeIntegration(input);
  if (!normalized.slug || !normalized.name) throw badRequest('slug and name are required');
  await assertCredential(normalized.credentialId, p);
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO integration_registry
       (id,slug,name,adapter_type,source_ref_type,source_ref_id,base_url,credential_id,
        config_json,is_enabled,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, normalized.slug, normalized.name, normalized.adapterType, normalized.sourceRefType,
      normalized.sourceRefId, normalized.baseUrl, normalized.credentialId,
      JSON.stringify(normalized.config), normalized.isEnabled ? 1 : 0, context.actorId || null,
    ]
  );
  await audit(context, p, 'integration.registry.create', 'integration', id, {
    slug: normalized.slug,
    adapterType: normalized.adapterType,
  });
  return publicIntegration(await getIntegration(id, p));
}

async function updateIntegration(id, input, context = {}, pool = null) {
  const p = pool || getPool();
  const existing = await getIntegration(id, p);
  if (!existing) throw notFound('Integration not found');
  const normalized = normalizeIntegration(input, existing);
  await assertCredential(normalized.credentialId, p);
  await p.query(
    `UPDATE integration_registry SET slug=?,name=?,adapter_type=?,source_ref_type=?,
       source_ref_id=?,base_url=?,credential_id=?,config_json=?,is_enabled=?,
       last_validation_status=NULL,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
    [
      normalized.slug, normalized.name, normalized.adapterType, normalized.sourceRefType,
      normalized.sourceRefId, normalized.baseUrl, normalized.credentialId,
      JSON.stringify(normalized.config), normalized.isEnabled ? 1 : 0, id,
    ]
  );
  await audit(context, p, 'integration.registry.update', 'integration', id, {
    slug: normalized.slug,
    enabled: normalized.isEnabled,
  });
  return publicIntegration(await getIntegration(id, p));
}

async function validateIntegration(id, context = {}, pool = null) {
  const p = pool || getPool();
  const row = await getIntegration(id, p);
  if (!row) throw notFound('Integration not found');
  normalizeIntegration({}, row);
  if (row.credential_id) await assertCredential(row.credential_id, p);
  await p.query(
    `UPDATE integration_registry
     SET last_validation_status='configuration_valid',last_validated_at=CURRENT_TIMESTAMP(3)
     WHERE id=?`,
    [id]
  );
  await audit(context, p, 'integration.registry.validate', 'integration', id, {
    validation: 'configuration_only',
  });
  return {
    valid: true,
    mode: 'configuration_only',
    message: 'Configuration and credential reference are valid; live adapter testing begins in Phase 2.',
  };
}

function publicDestination(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    destinationType: row.destination_type,
    credentialId: row.credential_id || null,
    config: parseStoredJson(row.config_json, {}),
    isEnabled: Boolean(row.is_enabled),
    isProtectionTarget: Boolean(row.is_protection_target),
    lastValidationStatus: row.last_validation_status || null,
    lastValidatedAt: row.last_validated_at || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeDestination(input, existing = {}) {
  const destinationType = input.destinationType == null
    ? existing.destination_type
    : String(input.destinationType).trim();
  if (!DESTINATION_TYPES.includes(destinationType)) throw badRequest('Unsupported destination type');
  const config = input.config === undefined
    ? parseStoredJson(existing.config_json, {})
    : validatePublicConfig(input.config);
  validateDestinationConfig(destinationType, config);
  return {
    slug: input.slug == null ? existing.slug : assertSlug(input.slug),
    name: input.name == null ? existing.name : requiredText(input.name, 'name'),
    destinationType,
    credentialId: input.credentialId === undefined
      ? existing.credential_id || null
      : String(input.credentialId || '').trim() || null,
    config,
    isEnabled: input.isEnabled === undefined ? existing.is_enabled !== 0 : input.isEnabled !== false,
    isProtectionTarget: destinationType === 'local_staging'
      ? false
      : input.isProtectionTarget === undefined
        ? existing.is_protection_target !== 0
        : input.isProtectionTarget !== false,
  };
}

function validateDestinationConfig(type, config) {
  if (type === 's3') {
    requiredText(config.bucket, 'config.bucket', 255);
    if (config.endpoint) validateHttpsUrl(config.endpoint, 'config.endpoint');
  } else if (type === 'sftp') {
    assertPublicHost(config.host);
    const port = Number(config.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('Invalid SFTP port');
  } else if (type === 'https') {
    validateHttpsUrl(config.url, 'config.url');
  } else if (type === 'local_staging') {
    const relativePath = String(config.relativePath || 'preservation').trim();
    if (
      !relativePath ||
      relativePath.includes('..') ||
      relativePath.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(relativePath)
    ) {
      throw badRequest('Local staging path must be relative and remain within the configured artifact root');
    }
  }
}

async function getDestination(id, pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM preservation_destinations WHERE id=? LIMIT 1', [id]);
  return rows[0] || null;
}

async function listDestinations(pool = null) {
  const p = pool || getPool();
  const [rows] = await p.query('SELECT * FROM preservation_destinations ORDER BY name');
  return rows.map(publicDestination);
}

async function createDestination(input, context = {}, pool = null) {
  const p = pool || getPool();
  const normalized = normalizeDestination(input);
  if (!normalized.slug || !normalized.name) throw badRequest('slug and name are required');
  await assertCredential(normalized.credentialId, p);
  if (normalized.destinationType !== 'local_staging' && !normalized.credentialId) {
    throw badRequest('A credential reference is required for off-instance destinations');
  }
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO preservation_destinations
       (id,slug,name,destination_type,credential_id,config_json,is_enabled,
        is_protection_target,created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id, normalized.slug, normalized.name, normalized.destinationType,
      normalized.credentialId, JSON.stringify(normalized.config),
      normalized.isEnabled ? 1 : 0, normalized.isProtectionTarget ? 1 : 0,
      context.actorId || null,
    ]
  );
  await audit(context, p, 'preservation.destination.create', 'preservation_destination', id, {
    slug: normalized.slug,
    destinationType: normalized.destinationType,
    protectionTarget: normalized.isProtectionTarget,
  });
  return publicDestination(await getDestination(id, p));
}

async function updateDestination(id, input, context = {}, pool = null) {
  const p = pool || getPool();
  const existing = await getDestination(id, p);
  if (!existing) throw notFound('Destination not found');
  const normalized = normalizeDestination(input, existing);
  await assertCredential(normalized.credentialId, p);
  if (normalized.destinationType !== 'local_staging' && !normalized.credentialId) {
    throw badRequest('A credential reference is required for off-instance destinations');
  }
  await p.query(
    `UPDATE preservation_destinations
     SET slug=?,name=?,destination_type=?,credential_id=?,config_json=?,is_enabled=?,
         is_protection_target=?,last_validation_status=NULL,updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=?`,
    [
      normalized.slug, normalized.name, normalized.destinationType,
      normalized.credentialId, JSON.stringify(normalized.config),
      normalized.isEnabled ? 1 : 0, normalized.isProtectionTarget ? 1 : 0, id,
    ]
  );
  await audit(context, p, 'preservation.destination.update', 'preservation_destination', id, {
    slug: normalized.slug,
    enabled: normalized.isEnabled,
  });
  return publicDestination(await getDestination(id, p));
}

async function validateDestination(id, context = {}, pool = null) {
  const p = pool || getPool();
  const row = await getDestination(id, p);
  if (!row) throw notFound('Destination not found');
  normalizeDestination({}, row);
  if (row.credential_id) await assertCredential(row.credential_id, p);
  await p.query(
    `UPDATE preservation_destinations
     SET last_validation_status='configuration_valid',last_validated_at=CURRENT_TIMESTAMP(3)
     WHERE id=?`,
    [id]
  );
  await audit(context, p, 'preservation.destination.validate', 'preservation_destination', id, {
    validation: 'configuration_only',
  });
  return {
    valid: true,
    mode: 'configuration_only',
    protectionTarget: Boolean(row.is_protection_target),
    message: 'Configuration and credential reference are valid; live delivery testing begins in Phase 2.',
  };
}

function parseStoredJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
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
  SECRET_KINDS,
  ADAPTER_TYPES,
  SOURCE_REF_TYPES,
  DESTINATION_TYPES,
  assertSlug,
  validatePublicConfig,
  validateHttpsUrl,
  assertPublicHost,
  publicSecret,
  listSecrets,
  createSecret,
  rotateSecret,
  retireSecret,
  resolveSecret,
  publicIntegration,
  normalizeIntegration,
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  validateIntegration,
  publicDestination,
  normalizeDestination,
  validateDestinationConfig,
  listDestinations,
  getDestination,
  createDestination,
  updateDestination,
  validateDestination,
};
