const crypto = require('crypto');
const { getPool } = require('../db/pool');

const SENSITIVE_KEY_RE = /(?:secret|password|authorization|credential|token|private[_-]?key|api[_-]?key)/i;

function sanitizeAuditDetails(value, depth = 0) {
  if (depth > 5) return '[depth-limited]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(/[\r\n\t]/g, ' ').slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeAuditDetails(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 1000);
  const output = {};
  Object.entries(value).slice(0, 100).forEach(([key, item]) => {
    output[String(key).slice(0, 128)] = SENSITIVE_KEY_RE.test(key)
      ? '[redacted]'
      : sanitizeAuditDetails(item, depth + 1);
  });
  return output;
}

async function recordPreservationAudit(event, pool = null) {
  const p = pool || getPool();
  const id = crypto.randomUUID();
  await p.query(
    `INSERT INTO preservation_audit_events
       (id,request_id,actor_type,actor_id,action,entity_type,entity_id,outcome,details_json)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      clean(event.requestId, 64),
      clean(event.actorType, 32),
      clean(event.actorId, 128),
      clean(event.action, 128) || 'preservation.unknown',
      clean(event.entityType, 64) || 'preservation',
      clean(event.entityId, 191),
      clean(event.outcome, 24) || 'success',
      JSON.stringify(sanitizeAuditDetails(event.details || {})),
    ]
  );
  return id;
}

async function listPreservationAudit(filters = {}, pool = null) {
  const p = pool || getPool();
  const where = [];
  const params = [];
  if (filters.entityType) {
    where.push('entity_type = ?');
    params.push(clean(filters.entityType, 64));
  }
  if (filters.entityId) {
    where.push('entity_id = ?');
    params.push(clean(filters.entityId, 191));
  }
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  params.push(limit);
  const [rows] = await p.query(
    `SELECT id,request_id,actor_type,actor_id,action,entity_type,entity_id,outcome,
            details_json,created_at
     FROM preservation_audit_events
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT ?`,
    params
  );
  return rows.map((row) => ({
    id: row.id,
    requestId: row.request_id || null,
    actorType: row.actor_type || null,
    actorId: row.actor_id || null,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id || null,
    outcome: row.outcome,
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at,
  }));
}

function clean(value, length) {
  if (value == null) return null;
  return String(value).trim().slice(0, length) || null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  sanitizeAuditDetails,
  recordPreservationAudit,
  listPreservationAudit,
};
