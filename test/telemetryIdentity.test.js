const assert = require('assert/strict');
const { resolveTelemetryIdentity, isGeneric } = require('../src/services/telemetryIdentity');

async function run() {
  assert.equal(isGeneric('system'), true);
  assert.equal(isGeneric('Admin'), true);
  assert.equal(isGeneric('jane.agent'), false);

  const exact = await resolveTelemetryIdentity({
    query: async (sql, params) => {
      assert.match(sql, /FROM users WHERE id = \?/);
      assert.deepEqual(params, ['user-123', 'location-1']);
      return [[{
        id: 'user-123', username: 'jane.agent', crmUserName: 'Jane Agent', email: 'jane@example.com',
      }]];
    },
  }, {
    locationId: 'location-1', userId: 'user-123', username: 'Admin',
  });
  assert.deepEqual(exact, {
    resolved: true,
    matchedBy: 'userId',
    userId: 'user-123',
    username: 'jane.agent',
    email: 'jane@example.com',
  });

  const generic = await resolveTelemetryIdentity({
    query: async () => { throw new Error('Generic placeholders must not be queried'); },
  }, {
    locationId: 'location-1', userId: 'system', username: 'Admin',
  });
  assert.equal(generic.resolved, false);
  assert.equal(generic.userId, null);
  assert.equal(generic.username, null);

  const byUsername = await resolveTelemetryIdentity({
    query: async (sql, params) => {
      assert.match(sql, /LOWER\(username\)/);
      assert.deepEqual(params, ['jane.agent', 'location-1']);
      return [[{
        id: 'user-123', username: 'jane.agent', crmUserName: null, email: 'jane@example.com',
      }]];
    },
  }, {
    locationId: 'location-1', username: 'jane.agent',
  });
  assert.equal(byUsername.resolved, true);
  assert.equal(byUsername.matchedBy, 'username');
  assert.equal(byUsername.userId, 'user-123');

  console.log('Telemetry identity tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
