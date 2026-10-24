const express = require('express');
const crypto = require('crypto');
const path = require('path');
const mysql = require('mysql2/promise');
const {
  ROOT,
  writeEnvFile,
  allowReinstall,
  generateAdminBasePath,
  isLocalDeployment,
} = require('../config');
const { testConnection, createPool, setPool, closePool } = require('../db/pool');
const { applySchema, markInstalled } = require('../db/migrate');
const { createAdmin, validPassword } = require('../services/adminUsers');
const { createKey } = require('../services/apiKeys');
const { installLimiter } = require('../middleware/rateLimit');
const { generateInstanceIdentity, identityEnv } = require('../instanceIdentity');

function createInstallRouter(appState) {
  const router = express.Router();

  function notFound(res) {
    return res.status(404).send('Not found');
  }

  function alreadyInstalledResponse(res) {
    return res.status(404).json({ error: 'Not found' });
  }

  router.get('/status', async (req, res) => {
    if (appState.installed && !allowReinstall()) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({
      installed: appState.installed,
      configured: appState.configured,
      allowReinstall: allowReinstall(),
    });
  });

  router.post('/test-db', installLimiter, async (req, res) => {
    if (appState.installed && !allowReinstall()) {
      return alreadyInstalledResponse(res);
    }
    const { host, port, user, password, database, createDatabase } = req.body || {};
    if (!user || !database) {
      return res.status(400).json({ error: 'user and database are required' });
    }
    try {
      await testConnection({
        host,
        port,
        user,
        password,
        database,
        createDatabase: Boolean(createDatabase),
      });
      res.json({ ok: true, message: 'Connection successful' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/complete', installLimiter, async (req, res) => {
    if (appState.installed && !allowReinstall()) {
      return alreadyInstalledResponse(res);
    }

    const {
      host = '127.0.0.1',
      port = 3306,
      user,
      password = '',
      database,
      createDatabase = true,
      adminUsername,
      adminPassword,
      adminEmail = null,
      createFirstApiKey = false,
      firstKeyName = 'Research API Key',
      appPort,
      instanceIdentity = {},
    } = req.body || {};

    if (!user || !database) {
      return res.status(400).json({ error: 'Database user and name are required' });
    }
    if (!adminUsername || !adminPassword) {
      return res.status(400).json({ error: 'Admin username and password are required' });
    }
    try { validPassword(adminPassword); }
    catch (error) { return res.status(400).json({ error: error.message }); }

    let identity;
    try {
      identity = generateInstanceIdentity(instanceIdentity && typeof instanceIdentity === 'object'
        ? instanceIdentity
        : {});
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    let tempConn;
    try {
      tempConn = await mysql.createConnection({
        host,
        port: Number(port),
        user,
        password,
        multipleStatements: true,
      });
      const safeDb = String(database).replace(/`/g, '');
      if (createDatabase) {
        await tempConn.query(
          `CREATE DATABASE IF NOT EXISTS \`${safeDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
      }
      await tempConn.query(`USE \`${safeDb}\``);
      await tempConn.end();
      tempConn = null;

      const sessionSecret = crypto.randomBytes(48).toString('hex');
      const secretBoxKey = crypto.randomBytes(48).toString('hex');
      const forensicKey = crypto.randomBytes(48).toString('hex');
      const adminBasePath = generateAdminBasePath();

      const local = isLocalDeployment();
      writeEnvFile({
        PORT: appPort || process.env.PORT || 3000,
        NODE_ENV: local ? 'development' : 'production',
        DB_HOST: host,
        DB_PORT: Number(port),
        DB_USER: user,
        DB_PASSWORD: password,
        DB_NAME: database,
        SESSION_SECRET: sessionSecret,
        SECRET_BOX_KEY: secretBoxKey,
        FORENSIC_KEY: forensicKey,
        ADMIN_BASE_PATH: adminBasePath,
        ALLOW_REINSTALL: 'false',
        COOKIE_SECURE: local ? 'false' : 'true',
        TRUST_PROXY: local ? '0' : (process.env.TRUST_PROXY || '1'),
        ...identityEnv(identity),
      });

      await closePool();
      const pool = createPool({
        host,
        port: Number(port),
        user,
        password,
        database,
      });
      setPool(pool);

      await applySchema(pool);
      await createAdmin(
        {
          username: adminUsername,
          password: adminPassword,
          email: adminEmail,
          role: 'admin',
        },
        pool
      );

      let firstKey = null;
      if (createFirstApiKey) {
        firstKey = await createKey({ name: firstKeyName, createdBy: null }, pool);
      }

      await markInstalled(pool);

      appState.installed = true;
      appState.configured = true;
      appState.sessionSecret = sessionSecret;
      appState.adminBasePath = adminBasePath;

      if (typeof appState.onInstalled === 'function') {
        await appState.onInstalled();
      }

      res.json({
        ok: true,
        message: 'Installation complete',
        adminBasePath,
        adminLoginUrl: `${adminBasePath}/login`,
        redirect: `${adminBasePath}/login`,
        warning:
          'Bookmark the admin login URL now. It is not linked from the public site and will not be shown again.',
        instance: {
          instanceId: identity.instanceId,
          publicApiBasePath: identity.publicApiBasePath,
          webhookBasePath: identity.webhookBasePath,
          healthPath: identity.healthPath,
          apiKeyPrefix: identity.apiKeyPrefix,
          automationNamespace: identity.automationNamespace,
          apiDisplayName: identity.apiDisplayName,
        },
        apiKey: firstKey
          ? {
              id: firstKey.id,
              name: firstKey.name,
              key_prefix: firstKey.key_prefix,
              secret: firstKey.secret,
              warning: 'Copy this API key now. It will not be shown again.',
            }
          : null,
      });
    } catch (err) {
      console.error('Install failed:', err);
      if (tempConn) {
        try {
          await tempConn.end();
        } catch {
          /* ignore */
        }
      }
      res.status(500).json({ error: err.message || 'Installation failed' });
    }
  });

  router.get('/', async (req, res) => {
    if (appState.installed && !allowReinstall()) {
      return notFound(res);
    }
    res.sendFile(path.join(ROOT, 'public', 'install', 'index.html'));
  });

  return router;
}

module.exports = { createInstallRouter };
