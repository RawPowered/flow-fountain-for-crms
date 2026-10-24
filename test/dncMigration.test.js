const assert = require('assert/strict');
const { ensureDncScreeningMigration } = require('../src/db/migrate');

async function run() {
  const calls = [];
  const connection = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT setting_value')) return [[]];
      return [{ affectedRows: 1 }];
    },
    beginTransaction: async () => calls.push({ sql: 'BEGIN' }),
    commit: async () => calls.push({ sql: 'COMMIT' }),
    rollback: async () => calls.push({ sql: 'ROLLBACK' }),
  };
  await ensureDncScreeningMigration(connection);
  assert.ok(calls.some((call) => call.sql.includes("status = 'dnc_pending'")));
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO app_settings')));
  assert.ok(calls.some((call) => call.sql === 'COMMIT'));
  assert.ok(!calls.some((call) => call.sql === 'ROLLBACK'));

  let began = false;
  await ensureDncScreeningMigration({
    query: async () => [[{ setting_value: 'complete' }]],
    beginTransaction: async () => { began = true; },
  });
  assert.equal(began, false);
  console.log('DNC migration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
