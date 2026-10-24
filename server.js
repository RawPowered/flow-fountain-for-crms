const { loadEnv, getSessionSecret, assertRuntimeSecurity } = require('./src/config');
const { initDatabase, applySchema } = require('./src/db/migrate');
const { getPool } = require('./src/db/pool');
const { createApp } = require('./src/app');
const { purgeOldEvents } = require('./src/services/sentinel');
const { purgeOldLoginEvents } = require('./src/services/loginSecurity');
const { runSentinelPreflight } = require('./src/services/sentinelPreflight');
const { startPreservationWorker } = require('./src/services/preservationWorker');

async function main() {
  loadEnv();

  const appState = {
    installed: false,
    configured: false,
    sentinelReady: false,
    sentinelPreflight: null,
    sessionSecret: getSessionSecret(),
  };

  const dbState = await initDatabase();
  appState.installed = Boolean(dbState.installed);
  appState.configured = Boolean(dbState.configured);
  if (dbState.error) {
    console.warn('DB not ready:', dbState.error);
  }
  assertRuntimeSecurity(appState);

  // Ensure new tables (e.g. api_sentinel_events) exist after upgrades
  if (appState.installed && appState.configured) {
    try {
      await applySchema(getPool());
      appState.sentinelPreflight = await runSentinelPreflight(getPool());
      appState.sentinelReady = appState.sentinelPreflight.ready;
      if (!appState.sentinelReady) {
        console.error(
          `Sentinel preflight NOT READY: ${appState.sentinelPreflight.failed} failed, ${appState.sentinelPreflight.warnings} warning(s)`
        );
      }
    } catch (err) {
      appState.sentinelReady = false;
      console.error(`Sentinel/schema initialization failed code=${err.code || err.name || 'INITIALIZATION_FAILED'}`);
    }
  }

  const app = createApp(appState);
  if (appState.installed && appState.configured) startPreservationWorker();
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '127.0.0.1';

  const server = app.listen(PORT, HOST, () => {
    console.log(`API server listening on port ${server.address().port}`);
    if (!appState.installed) {
      console.log(`Installation required → /install`);
    } else {
      // Do not print full admin path to shared logs if avoidable; hint only
      console.log('Installed. Admin path is in ADMIN_BASE_PATH (.env). Public site does not link it.');
    }
    const corsAll = String(process.env.CORS_ALLOW_ALL || '').toLowerCase() === 'true';
    const corsOrigins = process.env.CORS_ORIGINS || '';
    console.log(
      corsAll
        ? 'CORS_ALLOW_ALL=true'
        : corsOrigins
          ? `CORS_ORIGINS=${corsOrigins}`
          : 'CORS not open to browsers — set CORS_ORIGINS or CORS_ALLOW_ALL in .env'
    );
  });

  // Daily-ish retention cleanup (every 6 hours)
  if (appState.installed) {
    const purgeAll = () => {
      purgeOldEvents();
      purgeOldLoginEvents();
    };
    setInterval(purgeAll, 6 * 60 * 60 * 1000);
    setTimeout(purgeAll, 60 * 1000);
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
