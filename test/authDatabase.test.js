const assert = require('assert/strict');
const bcrypt = require('bcryptjs');
const { verifyLegacyUserLogin } = require('../src/routes/api');
const {
  AUTH_REQUIRED_COLUMNS,
  AUTH_REQUIRED_INDEXES,
  verifyAuthenticationDatabase,
} = require('../src/services/sentinelHealth');
const { preparePasswordCredential } = require('../src/services/loginSecurity');

async function run() {
  const password = 'Correct-Horse-7';
  const passwordHash = await bcrypt.hash(password, 4);
  const prepared = await preparePasswordCredential({
    password,
    passwordHash: 'legacy-value-that-must-not-win',
  });
  assert.equal(prepared.scheme, 'bcrypt');
  assert.equal(await bcrypt.compare(password, prepared.value), true);
  await assert.rejects(
    preparePasswordCredential({ password: 'short' }),
    (error) => error.code === 'PASSWORD_TOO_SHORT'
  );
  await assert.rejects(
    preparePasswordCredential({ passwordHash: 'client-reusable-hash' }),
    (error) => error.code === 'PASSWORD_HASH_UNSUPPORTED'
  );
  const queries = [];
  const user = {
    id: 'user-1',
    locationId: 'location-1',
    username: 'Gato',
    email: 'gato@example.com',
    passwordHash,
    role: 'agent',
    crmUserId: null,
    crmUserName: 'Gato',
  };
  const legacyPool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM crm_integrations i')) {
        return [[{ integration_count: 0, grant_count: 0 }]];
      }
      if (sql.includes('FROM users WHERE username = ? AND locationId = ?')) {
        assert.deepEqual(params, ['Gato', 'location-1']);
        return [[user]];
      }
      throw new Error(`Unexpected Legacy authentication query: ${sql}`);
    },
  };

  const authenticated = await verifyLegacyUserLogin('api-key-1', {
    locationId: 'location-1',
    username: 'Gato',
    password,
  }, legacyPool);
  assert.equal(authenticated.ok, true);
  assert.equal(authenticated.user.id, 'user-1');
  assert.equal(Object.prototype.hasOwnProperty.call(authenticated.user, 'passwordHash'), false);
  assert.equal(queries[0].sql.includes('FROM crm_integrations i'), true);
  assert.equal(queries[1].sql.includes('FROM users WHERE username = ? AND locationId = ?'), true);

  const denied = await verifyLegacyUserLogin('api-key-1', {
    locationId: 'location-1',
    username: 'Gato',
    password: 'Wrong-Password-7',
  }, legacyPool);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'password_mismatch');

  const staleClientHash = '0'.repeat(64);
  const conflicting = await verifyLegacyUserLogin('api-key-1', {
    locationId: 'location-1', username: 'Gato',
    password: 'Wrong-Password-7', passwordHash: staleClientHash,
  }, legacyPool);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.reason, 'password_mismatch');

  const correctPlaintextWins = await verifyLegacyUserLogin('api-key-1', {
    locationId: 'location-1', username: '  Gato  ',
    password, passwordHash: staleClientHash,
  }, legacyPool);
  assert.equal(correctPlaintextWins.ok, true, 'a stale optional client hash must not override valid plaintext');
  assert.equal(correctPlaintextWins.passwordScheme, 'bcrypt');

  const bcryptHashOnly = await verifyLegacyUserLogin('api-key-1', {
    locationId: 'location-1', username: 'Gato', passwordHash: staleClientHash,
  }, legacyPool);
  assert.equal(bcryptHashOnly.ok, false);
  assert.equal(bcryptHashOnly.reason, 'bcrypt_plaintext_required');

  let usersQueried = false;
  const unassignedPool = {
    async query(sql) {
      if (sql.includes('FROM crm_integrations i')) {
        return [[{ integration_count: 1, grant_count: 0 }]];
      }
      if (sql.includes('FROM users')) usersQueried = true;
      throw new Error(`Unexpected unassigned query: ${sql}`);
    },
  };
  await assert.rejects(
    verifyLegacyUserLogin('api-key-1', {
      locationId: 'location-1', username: 'Gato', password,
    }, unassignedPool),
    (error) => error.status === 403
  );
  assert.equal(usersQueried, false, 'an unassigned key must not reach the users table');

  const healthy = await verifyAuthenticationDatabase(healthPool({
    totalUsers:3, credentialUsers:3, bcryptUsers:3,
  }));
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.metrics.source, 'core');
  assert.equal(healthy.metrics.databaseName, 'Legacy');
  assert.equal(healthy.metrics.credentialUsers, 3);
  assert.equal(JSON.stringify(healthy).includes(passwordHash), false);

  const legacyMigration = await verifyAuthenticationDatabase(healthPool());
  assert.equal(legacyMigration.status, 'degraded');
  assert.equal(legacyMigration.metrics.legacyHashUsers, 1);
  assert.equal(legacyMigration.metrics.missingCredentialUsers, 1);

  const missingIndex = await verifyAuthenticationDatabase(healthPool({
    indexes: AUTH_REQUIRED_INDEXES.slice(0, 1),
  }));
  assert.equal(missingIndex.status, 'degraded');
  assert.deepEqual(missingIndex.metrics.missingIndexes, ['idx_users_location_email']);

  const missingColumn = await verifyAuthenticationDatabase(healthPool({
    columns: AUTH_REQUIRED_COLUMNS.filter((name) => name !== 'passwordHash'),
  }));
  assert.equal(missingColumn.status, 'critical');
  assert.deepEqual(missingColumn.metrics.missingColumns, ['passwordHash']);

  const noCredentials = await verifyAuthenticationDatabase(healthPool({ credentialUsers: 0 }));
  assert.equal(noCredentials.status, 'critical');

  console.log('Legacy authentication database tests passed');
}

function healthPool({
  columns = AUTH_REQUIRED_COLUMNS,
  indexes = AUTH_REQUIRED_INDEXES,
  totalUsers = 4,
  credentialUsers = 3,
  bcryptUsers = 2,
} = {}) {
  return {
    async query(sql) {
      if (sql === 'SELECT DATABASE() AS databaseName') {
        return [[{ databaseName: 'Legacy' }]];
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return [columns.map((columnName) => ({ columnName }))];
      }
      if (sql.includes('information_schema.STATISTICS')) {
        return [indexes.map((indexName) => ({ indexName }))];
      }
      if (sql.includes('COUNT(*) AS totalUsers')) {
        return [[{ totalUsers, credentialUsers, bcryptUsers }]];
      }
      throw new Error(`Unexpected authentication health query: ${sql}`);
    },
  };
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
