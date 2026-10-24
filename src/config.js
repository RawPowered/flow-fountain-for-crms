const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  generateInstanceIdentity,
  identityFromEnv,
  identityEnv,
  getInstanceIdentity,
} = require('./instanceIdentity');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function loadEnv() {
  require('dotenv').config({ path: ENV_PATH });
}

function getDbConfig(overrides = {}) {
  return {
    host: overrides.host || process.env.DB_HOST || '127.0.0.1',
    port: Number(overrides.port || process.env.DB_PORT || 3306),
    user: overrides.user || process.env.DB_USER || '',
    password: overrides.password !== undefined ? overrides.password : (process.env.DB_PASSWORD || ''),
    database: overrides.database || process.env.DB_NAME || '',
  };
}

function hasDbEnv() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
}

function generateAdminBasePath() {
  const token = crypto.randomBytes(24).toString('base64url');
  return `/p/${token}`;
}

/** Normalize to form /p/xxx with no trailing slash (except root which we never use). */
function normalizeAdminBasePath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+$/, '');
  if (p.length < 8) return null;
  // prevent mounting at public well-known paths
  const blocked = ['', '/', '/admin', '/api', '/install', '/docs', '/health', '/css', '/js'];
  if (blocked.includes(p.toLowerCase())) return null;
  return p;
}

/**
 * Secret control-plane base path. Prefer env; if missing, derive stable path from SESSION_SECRET
 * so existing installs keep working after upgrade without reinstall.
 */
function getAdminBasePath() {
  const fromEnv = normalizeAdminBasePath(process.env.ADMIN_BASE_PATH);
  if (fromEnv) return fromEnv;
  const secret = process.env.SESSION_SECRET || 'dev-only-change-me';
  const digest = crypto.createHash('sha256').update(`admin-path:${secret}`).digest('base64url').slice(0, 32);
  return `/p/${digest}`;
}

function getCorsOrigins() {
  const raw = process.env.CORS_ORIGINS || '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function getAdminIpAllowlist() {
  const raw = process.env.ADMIN_IP_ALLOWLIST || '';
  if (!raw.trim()) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getGoogleOAuthConfig() {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  const allowedEmails = [...new Set(String(process.env.GOOGLE_OAUTH_ALLOWED_EMAILS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const hasAnyConfiguration = Boolean(clientId || clientSecret || redirectUri || allowedEmails.length);
  // MFA is mandatory for admin if configured (SP-03 hardening)
  const required = hasAnyConfiguration;
  const requestedSessionHours = Number(process.env.ADMIN_MFA_SESSION_HOURS || 12);
  const sessionHours = Number.isFinite(requestedSessionHours)
    ? Math.min(Math.max(requestedSessionHours, 1), 168)
    : 12;
  const errors = [];
  if (hasAnyConfiguration) {
    if (!clientId) errors.push('GOOGLE_OAUTH_CLIENT_ID is missing');
    if (!clientSecret) errors.push('GOOGLE_OAUTH_CLIENT_SECRET is missing');
    if (!redirectUri) errors.push('GOOGLE_OAUTH_REDIRECT_URI is missing');
    if (!allowedEmails.length) errors.push('GOOGLE_OAUTH_ALLOWED_EMAILS is empty');
  }
  if (redirectUri) {
    try {
      const url = new URL(redirectUri);
      const local = ['localhost', '127.0.0.1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !local) errors.push('GOOGLE_OAUTH_REDIRECT_URI must use HTTPS');
      if (url.search || url.hash) errors.push('GOOGLE_OAUTH_REDIRECT_URI cannot contain a query or fragment');
      if (url.pathname !== `${getAdminBasePath()}/auth/google/callback`) {
        errors.push('GOOGLE_OAUTH_REDIRECT_URI path does not match ADMIN_BASE_PATH');
      }
    } catch {
      errors.push('GOOGLE_OAUTH_REDIRECT_URI is invalid');
    }
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    allowedEmails,
    hasAnyConfiguration,
    required,
    sessionHours,
    configured: hasAnyConfiguration && errors.length === 0,
    errors,
  };
}

function getSentinelRetentionDays() {
  const n = Number(process.env.SENTINEL_RETENTION_DAYS || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function getSentinelForensicConfig() {
  const retention = Number(process.env.SENTINEL_FORENSIC_RETENTION_DAYS || 7);
  const bodyBytes = Number(process.env.SENTINEL_FORENSIC_MAX_BODY_BYTES || 24576);
  return {
    enabled: String(process.env.SENTINEL_FORENSICS_ENABLED || 'true').toLowerCase() !== 'false',
    retentionDays: Number.isFinite(retention) && retention > 0 ? Math.min(retention, 30) : 7,
    maxBodyBytes: Number.isFinite(bodyBytes) && bodyBytes >= 1024
      ? Math.min(bodyBytes, 65536)
      : 24576,
  };
}

function healthEnabled() {
  return String(process.env.HEALTH_PUBLIC || 'true').toLowerCase() !== 'false';
}

/**
 * White-label CRM app origin for Session Harbor contact URL building.
 */
function getCrmAppOrigin() {
  const raw =
    process.env.CRM_APP_ORIGIN ||
    '';
  return String(raw).trim().replace(/\/$/, '');
}

function getCustomCrmConfig() {
  const raw = String(process.env.CUSTOM_CRM_BASE_URL || '').trim();
  let baseUrl = '';
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.username && !url.password &&
        url.pathname === '/' && !url.search && !url.hash) baseUrl = url.origin;
  } catch { /* Unconfigured adapters remain disabled. */ }
  return {
    enabled: Boolean(baseUrl) && process.env.CUSTOM_CRM_PROXY_ENABLED === 'true',
    baseUrl,
    authorization: String(process.env.CUSTOM_CRM_AUTHORIZATION || ''),
    allowClientUpstreamAuth: process.env.CUSTOM_CRM_ALLOW_CLIENT_AUTH === 'true',
    allowedPathPrefixes: String(process.env.CUSTOM_CRM_ALLOWED_PATHS || '/backend')
      .split(',').map((value) => value.trim()).filter((value) => /^\/[A-Za-z0-9/_-]+$/.test(value)),
    timeoutMs: Math.min(Math.max(Number(process.env.CUSTOM_CRM_TIMEOUT_MS) || 15000, 100), 30000),
  };
}

function isLocalDeployment() {
  return ['127.0.0.1', '::1', 'localhost'].includes(process.env.HOST || '127.0.0.1') &&
    process.env.LOCAL_DEVELOPMENT !== 'false';
}

/** Max JSON size for dialer workspace state (bytes of stringified JSON). */
function getWorkspaceMaxBytes() {
  const n = Number(process.env.WORKSPACE_MAX_BYTES || 262144);
  return Number.isFinite(n) && n > 1024 ? n : 262144;
}

function getParrotConfig() {
  const raw = String(process.env.PARROT_BASE_URL || '').trim().replace(/\/$/, '');
  const token = String(process.env.PARROT_SERVICE_TOKEN || '').trim();
  const requested = Number(process.env.PARROT_TIMEOUT_MS || 15000);
  const timeoutMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 100), 30000) : 15000;
  if (!raw) return { enabled:false, baseUrl:'', token, timeoutMs, error:'base_url_missing' };
  let url;
  try { url = new URL(raw); } catch { return { enabled:false, baseUrl:'', token, timeoutMs, error:'invalid_url' }; }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { enabled:false, baseUrl:'', token, timeoutMs, error:'https_required' };
  }
  if (!token) return { enabled:false, baseUrl:url.toString().replace(/\/$/, ''), token:'', timeoutMs, error:'token_missing' };
  return { enabled:true, baseUrl:url.toString().replace(/\/$/, ''), token, timeoutMs, error:null };
}

function getPreservationConfig() {
  const configuredRoot = String(process.env.PRESERVATION_STAGING_ROOT || '').trim();
  const stagingRoot = path.resolve(configuredRoot || path.join(ROOT, 'var', 'preservation'));
  if (stagingRoot === path.parse(stagingRoot).root || stagingRoot === path.resolve(ROOT)) {
    throw new Error('PRESERVATION_STAGING_ROOT must be a dedicated subdirectory');
  }
  const bounded = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(Math.floor(number), min), max) : fallback;
  };
  return {
    enabled: String(process.env.PRESERVATION_WORKER_ENABLED || 'true').toLowerCase() !== 'false',
    stagingRoot,
    pollMs: bounded(process.env.PRESERVATION_WORKER_POLL_MS, 15000, 1000, 300000),
    chunkSize: bounded(process.env.PRESERVATION_CHUNK_SIZE, 500, 50, 5000),
    maxRecords: bounded(process.env.PRESERVATION_MAX_RECORDS, 1000000, 1, 10000000),
    maxArtifactBytes: bounded(
      process.env.PRESERVATION_MAX_ARTIFACT_BYTES,
      1073741824,
      1048576,
      2147483648
    ),
    maxAttempts: bounded(process.env.PRESERVATION_MAX_ATTEMPTS, 3, 1, 10),
  };
}

function writeEnvFile(values) {
  const combinedEnv = { ...process.env, ...values };
  const identity = combinedEnv.INSTANCE_ID
    ? identityFromEnv(combinedEnv, { allowDevelopmentDefaults: false })
    : generateInstanceIdentity();
  const instance = identityEnv(identity);
  const lines = [
    `# Generated by instance installer ${new Date().toISOString()}`,
    `PORT=${values.PORT || process.env.PORT || 3000}`,
    `HOST=${values.HOST || process.env.HOST || '127.0.0.1'}`,
    `LOCAL_DEVELOPMENT=${values.LOCAL_DEVELOPMENT || process.env.LOCAL_DEVELOPMENT || 'true'}`,
    `NODE_ENV=${values.NODE_ENV || 'production'}`,
    `INSTANCE_ID=${instance.INSTANCE_ID}`,
    `PUBLIC_API_BASE_PATH=${instance.PUBLIC_API_BASE_PATH}`,
    `WEBHOOK_BASE_PATH=${instance.WEBHOOK_BASE_PATH}`,
    `HEALTH_PATH=${instance.HEALTH_PATH}`,
    `API_KEY_PREFIX=${instance.API_KEY_PREFIX}`,
    `AUTOMATION_NAMESPACE=${instance.AUTOMATION_NAMESPACE}`,
    `SESSION_COOKIE_NAME=${instance.SESSION_COOKIE_NAME}`,
    `OPERATOR_COOKIE_NAME=${instance.OPERATOR_COOKIE_NAME}`,
    `API_DISPLAY_NAME=${instance.API_DISPLAY_NAME}`,
    `API_METADATA_HEADERS_ENABLED=${instance.API_METADATA_HEADERS_ENABLED}`,
    `API_METADATA_HEADER_PREFIX=${instance.API_METADATA_HEADER_PREFIX}`,
    `DB_HOST=${values.DB_HOST}`,
    `DB_PORT=${values.DB_PORT || 3306}`,
    `DB_USER=${values.DB_USER}`,
    `DB_PASSWORD=${values.DB_PASSWORD}`,
    `DB_NAME=${values.DB_NAME}`,
    `SESSION_SECRET=${values.SESSION_SECRET}`,
    `SECRET_BOX_KEY=${values.SECRET_BOX_KEY || process.env.SECRET_BOX_KEY || ''}`,
    `FORENSIC_KEY=${values.FORENSIC_KEY || process.env.FORENSIC_KEY || ''}`,
    `ADMIN_BASE_PATH=${values.ADMIN_BASE_PATH || getAdminBasePath()}`,
    `ALLOW_REINSTALL=${values.ALLOW_REINSTALL || 'false'}`,
    `COOKIE_SECURE=${values.COOKIE_SECURE || process.env.COOKIE_SECURE || 'true'}`,
    `TRUST_PROXY=${values.TRUST_PROXY || process.env.TRUST_PROXY || '0'}`,
    `CORS_ORIGINS=${values.CORS_ORIGINS || process.env.CORS_ORIGINS || ''}`,
    `HEALTH_PUBLIC=${values.HEALTH_PUBLIC || process.env.HEALTH_PUBLIC || 'true'}`,
    `SENTINEL_RETENTION_DAYS=${values.SENTINEL_RETENTION_DAYS || process.env.SENTINEL_RETENTION_DAYS || '30'}`,
    `SENTINEL_FORENSICS_ENABLED=${values.SENTINEL_FORENSICS_ENABLED || process.env.SENTINEL_FORENSICS_ENABLED || 'true'}`,
    `SENTINEL_FORENSIC_RETENTION_DAYS=${values.SENTINEL_FORENSIC_RETENTION_DAYS || process.env.SENTINEL_FORENSIC_RETENTION_DAYS || '7'}`,
    `SENTINEL_FORENSIC_MAX_BODY_BYTES=${values.SENTINEL_FORENSIC_MAX_BODY_BYTES || process.env.SENTINEL_FORENSIC_MAX_BODY_BYTES || '24576'}`,
    `SENTINEL_WRITER_MAX_QUEUE=${values.SENTINEL_WRITER_MAX_QUEUE || process.env.SENTINEL_WRITER_MAX_QUEUE || '5000'}`,
    `SENTINEL_WRITER_MAX_ATTEMPTS=${values.SENTINEL_WRITER_MAX_ATTEMPTS || process.env.SENTINEL_WRITER_MAX_ATTEMPTS || '4'}`,
    `SENTINEL_WRITER_RETRY_BASE_MS=${values.SENTINEL_WRITER_RETRY_BASE_MS || process.env.SENTINEL_WRITER_RETRY_BASE_MS || '50'}`,
    `DNC_SCRUB_KEY=${values.DNC_SCRUB_KEY || process.env.DNC_SCRUB_KEY || values.DNC_SCRUB__KEY || process.env.DNC_SCRUB__KEY || ''}`,
    `DNC_SCRUB_TIMEOUT_MS=${values.DNC_SCRUB_TIMEOUT_MS || process.env.DNC_SCRUB_TIMEOUT_MS || '30000'}`,
    `DNC_SCRUB_BATCH_SIZE=${values.DNC_SCRUB_BATCH_SIZE || process.env.DNC_SCRUB_BATCH_SIZE || '50'}`,
    `DNC_SCRUB_MAX_RETRIES=${values.DNC_SCRUB_MAX_RETRIES || process.env.DNC_SCRUB_MAX_RETRIES || '2'}`,
    `DNC_SCRUB_REQUESTS_PER_MINUTE=${values.DNC_SCRUB_REQUESTS_PER_MINUTE || process.env.DNC_SCRUB_REQUESTS_PER_MINUTE || '30'}`,
    `PARROT_BASE_URL=${values.PARROT_BASE_URL || process.env.PARROT_BASE_URL || ''}`,
    `PARROT_SERVICE_TOKEN=${values.PARROT_SERVICE_TOKEN || process.env.PARROT_SERVICE_TOKEN || ''}`,
    `PARROT_TIMEOUT_MS=${values.PARROT_TIMEOUT_MS || process.env.PARROT_TIMEOUT_MS || '15000'}`,
    `PRESERVATION_WORKER_ENABLED=${values.PRESERVATION_WORKER_ENABLED || process.env.PRESERVATION_WORKER_ENABLED || 'true'}`,
    `PRESERVATION_STAGING_ROOT=${values.PRESERVATION_STAGING_ROOT || process.env.PRESERVATION_STAGING_ROOT || ''}`,
    `PRESERVATION_WORKER_POLL_MS=${values.PRESERVATION_WORKER_POLL_MS || process.env.PRESERVATION_WORKER_POLL_MS || '15000'}`,
    `PRESERVATION_CHUNK_SIZE=${values.PRESERVATION_CHUNK_SIZE || process.env.PRESERVATION_CHUNK_SIZE || '500'}`,
    `PRESERVATION_MAX_RECORDS=${values.PRESERVATION_MAX_RECORDS || process.env.PRESERVATION_MAX_RECORDS || '1000000'}`,
    `PRESERVATION_MAX_ARTIFACT_BYTES=${values.PRESERVATION_MAX_ARTIFACT_BYTES || process.env.PRESERVATION_MAX_ARTIFACT_BYTES || '1073741824'}`,
    `PRESERVATION_MAX_ATTEMPTS=${values.PRESERVATION_MAX_ATTEMPTS || process.env.PRESERVATION_MAX_ATTEMPTS || '3'}`,
    '',
  ];
  const defined = new Set(lines.map((line) => line.split('=')[0]));
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const match of example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    const key = match[1];
    if (!defined.has(key) && process.env[key] !== undefined) lines.push(`${key}=${process.env[key]}`);
  }
  const encoded = lines.map((line) => {
    if (/[\r\n]/.test(line)) throw new Error('Configuration values cannot contain newlines');
    const index = line.indexOf('=');
    return index < 0 ? line : `${line.slice(0, index)}=${JSON.stringify(line.slice(index + 1))}`;
  });
  fs.writeFileSync(ENV_PATH, encoded.join('\n'), { encoding: 'utf8', mode: 0o600 });
  for (const [key, val] of Object.entries(instance)) process.env[key] = String(val);
  for (const [key, val] of Object.entries(values)) {
    if (val !== undefined && val !== null) process.env[key] = String(val);
  }
}

function getSessionSecret() {
  return process.env.SESSION_SECRET || 'dev-only-change-me';
}

function getSecretBoxKey() {
  return String(process.env.SECRET_BOX_KEY || '').trim();
}

function getForensicKey() {
  return String(process.env.FORENSIC_KEY || '').trim();
}

function assertRuntimeSecurity({ installed = false, configured = false } = {}) {
  if (process.env.NODE_ENV !== 'production' || !installed || !configured) return;
  const sessionSecret = String(process.env.SESSION_SECRET || '');
  if (sessionSecret.length < 32 || sessionSecret === 'dev-only-change-me') {
    throw new Error('Production SESSION_SECRET must be configured with at least 32 characters');
  }
  identityFromEnv(process.env, { allowDevelopmentDefaults: false });
}

function allowReinstall() {
  // SP-03: Hardened to false to close reinstall bypass vector
  return false;
}

function trustProxyHops() {
  const v = process.env.TRUST_PROXY;
  if (v === undefined || v === '') return 1;
  if (String(v).toLowerCase() === 'false' || v === '0') return false;
  const n = Number(v);
  return Number.isFinite(n) ? n : 1;
}

module.exports = {
  ROOT,
  ENV_PATH,
  loadEnv,
  getDbConfig,
  hasDbEnv,
  writeEnvFile,
  getSessionSecret,
  getSecretBoxKey,
  getForensicKey,
  assertRuntimeSecurity,
  allowReinstall,
  generateAdminBasePath,
  normalizeAdminBasePath,
  getAdminBasePath,
  getCorsOrigins,
  getAdminIpAllowlist,
  getGoogleOAuthConfig,
  getSentinelRetentionDays,
  getSentinelForensicConfig,
  healthEnabled,
  trustProxyHops,
  getCrmAppOrigin,
  getCustomCrmConfig,
  isLocalDeployment,
  getWorkspaceMaxBytes,
  getParrotConfig,
  getPreservationConfig,
  getInstanceIdentity,
  SCHEMA_VERSION: '49',
};
