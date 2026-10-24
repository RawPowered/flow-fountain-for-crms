const assert = require('assert/strict');
const {
  requireAdminRole, requireOwlAccess, assertAdminApiKeyScope, principalType,
} = require('../src/middleware/sessionAuth');
const { validPassword, createDelegatedAdmin, listTenantLocationIds } = require('../src/services/adminUsers');

function invoke(middleware, admin) {
  let nextCalled = false;
  let statusCode = null;
  const req = { session: admin ? { admin } : null };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { return body; },
  };
  middleware(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode };
}

assert.equal(principalType({ role: 'admin' }), 'root');
assert.equal(principalType({ role: 'viewer' }), 'viewer');
assert.equal(invoke(requireAdminRole, { principalType: 'platform' }).nextCalled, true);
assert.equal(invoke(requireAdminRole, { principalType: 'tenant' }).statusCode, 403);
assert.equal(invoke(requireOwlAccess, { principalType: 'tenant' }).nextCalled, true);
assert.equal(invoke(requireOwlAccess, { role: 'viewer' }).statusCode, 403);
assert.doesNotThrow(() => assertAdminApiKeyScope({ principalType: 'tenant', apiKeyId: 'key-1' }, 'key-1'));
assert.throws(
  () => assertAdminApiKeyScope({ principalType: 'tenant', apiKeyId: 'key-1' }, 'key-2'),
  (error) => error.status === 403
);
assert.equal(validPassword('LongPassword7'), 'LongPassword7');
assert.throws(() => validPassword('short'), (error) => error.status === 400);

(async () => {
  await assert.rejects(
    createDelegatedAdmin({ accountType: 'platform' }, { id: 'platform-1', principalType: 'platform' }),
    (error) => error.status === 403
  );
  await assert.rejects(
    createDelegatedAdmin({ accountType: 'tenant' }, { id: 'tenant-1', principalType: 'tenant' }),
    (error) => error.status === 403
  );
  const locations = await listTenantLocationIds('key-1', {
    query: async () => [[{ locationId: 'location-1' }, { locationId: 'location-2' }]],
  });
  assert.deepEqual(locations, ['location-1', 'location-2']);
  const writes = [];
  const delegated = await createDelegatedAdmin({
    accountType: 'tenant', apiKeyId: 'key-1', username: 'tenant.admin',
    email: 'tenant@example.com', password: 'LongPassword7',
  }, { id: 'root-1', principalType: 'root' }, {
    async query(sql) {
      if (sql.includes('FROM api_keys')) return [[{ id: 'key-1' }]];
      return [[]];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async query(sql, params) { writes.push({ sql, params }); return [{ affectedRows: 1 }]; },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  });
  assert.equal(delegated.accountType, 'tenant');
  assert.equal(writes.some((write) => write.sql.includes('admin_login_names')), true);
  assert.equal(writes.some((write) => write.sql.includes('tenant_administrators')), true);
  console.log('Admin RBAC tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
