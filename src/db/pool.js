const mysql = require('mysql2/promise');
const { getDbConfig } = require('../config');

let pool = null;

function createPool(configOverrides = {}) {
  const cfg = getDbConfig(configOverrides);
  if (!cfg.user || !cfg.database) {
    throw new Error('Database configuration incomplete');
  }
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: false,
    dateStrings: true,
  });
}

function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

function setPool(newPool) {
  pool = newPool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Test credentials without requiring an existing database (optional create). */
async function testConnection({ host, port, user, password, database, createDatabase = false }) {
  const conn = await mysql.createConnection({
    host: host || '127.0.0.1',
    port: Number(port || 3306),
    user,
    password: password || '',
    multipleStatements: true,
  });
  try {
    await conn.query('SELECT 1');
    if (database) {
      if (createDatabase) {
        await conn.query(
          `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
      }
      await conn.query(`USE \`${database.replace(/`/g, '')}\``);
      await conn.query('SELECT 1');
    }
    return { ok: true };
  } finally {
    await conn.end();
  }
}

module.exports = {
  createPool,
  getPool,
  setPool,
  closePool,
  testConnection,
};
