const assert = require('assert/strict');
const {
  normalizeServicePool,
  nextRoundRobinUser,
  fallbackUserForPool,
  assignDialer,
  DEFAULT_ASSIGNED_DIALER_FIELD_ID,
} = require('../src/services/dialerAssignments');
const { detectContactLanguage, DEFAULT_LANGUAGE_RULES } = require('../src/services/assignmentPolicies');

async function run() {
  assert.equal(normalizeServicePool('Kitchen Expansion'), 'kitchen');
  assert.equal(normalizeServicePool('Bathroom Remodel'), 'bathroom');
  assert.equal(normalizeServicePool('Home Addition'), 'home_addition');
  const languagePolicy = { defaultLanguageCode:'en', languageRules:DEFAULT_LANGUAGE_RULES };
  assert.equal(detectContactLanguage({ tags:['cc-pool-roofing', 'Español'] }, languagePolicy), 'es');
  assert.equal(detectContactLanguage({ tags:['enterprise'] }, languagePolicy), 'en');
  assert.equal(detectContactLanguage({ customFields:[{ id:'language-field', value:'Puerto Rico' }] }, {
    ...languagePolicy, languageFieldId:'language-field',
  }), 'es');

  const transactionQueries = [];
  const connection = {
    async beginTransaction() { transactionQueries.push('begin'); },
    async commit() { transactionQueries.push('commit'); },
    async rollback() { transactionQueries.push('rollback'); },
    release() { transactionQueries.push('release'); },
    async query(sql) {
      transactionQueries.push(sql);
      if (sql.includes('FROM owl_user_pool_permissions')) {
        return [[{ userId:'owl-2', crmUserId:'ghl-2' }]];
      }
      if (sql.startsWith('UPDATE owl_user_pool_permissions')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected round-robin query: ${sql}`);
    },
  };
  const selected = await nextRoundRobinUser({ async getConnection() { return connection; } }, 'location-1', 'roofing');
  assert.deepEqual(selected, { userId:'owl-2', crmUserId:'ghl-2', source:'round_robin' });
  assert.ok(transactionQueries.includes('commit'));

  const requests = [];
  const poolQueries = [];
  const pool = {
    async query(sql, params) {
      poolQueries.push({ sql, params });
      if (sql.includes('FROM owl_assignment_policies')) return [[]];
      if (sql.startsWith('SELECT id,crmUserId FROM users')) return [[{ id:'owl-owner', crmUserId:'ghl-owner' }]];
      if (sql.startsWith('INSERT INTO hawk_dialer_assignment_events')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected assignment query: ${sql}`);
    },
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (!options.method) return response(200, { contact:{ id:'contact-1', assignedTo:'ghl-owner', customFields:[] } });
    return response(200, { contact:{ id:'contact-1' } });
  };
  const result = await assignDialer(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', servicePool:'Roofing',
    integration:{ base_url:'https://services.leadconnectorhq.com' }, fetchImpl,
  });
  assert.equal(result.source, 'record_owner');
  assert.equal(result.assignedDialer, 'ghl-owner');
  assert.equal(result.ownerUpdated, false);
  const update = JSON.parse(requests[1].options.body);
  assert.equal(update.assignedTo, undefined);
  assert.deepEqual(update.customFields, [{ id:DEFAULT_ASSIGNED_DIALER_FIELD_ID, field_value:'ghl-owner' }]);
  assert.ok(poolQueries.some((item) => item.sql.startsWith('INSERT INTO hawk_dialer_assignment_events')));

  const fallbackRequests = [];
  const fallbackConnection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql) {
      if (sql.includes('FROM owl_user_pool_permissions')) return [[]];
      throw new Error(`Unexpected fallback transaction query: ${sql}`);
    },
  };
  const fallbackPool = {
    async getConnection() { return fallbackConnection; },
    async query(sql) {
      if (sql.includes('FROM owl_assignment_policies')) return [[]];
      if (sql.includes('FROM owl_service_pools sp')) {
        return [[{ serviceType:'Roofing', userId:'owl-fallback', crmUserId:'ghl-fallback' }]];
      }
      if (sql.startsWith('INSERT INTO hawk_dialer_assignment_events')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected fallback assignment query: ${sql}`);
    },
  };
  const fallbackFetch = async (url, options = {}) => {
    fallbackRequests.push({ url, options });
    if (!options.method) return response(200, { contact:{ id:'contact-2', customFields:[] } });
    return response(200, { contact:{ id:'contact-2' } });
  };
  const fallbackResult = await assignDialer(fallbackPool, {
    apiKeyId:'key-1', sourceSlug:'core', locationId:'location-1', contactId:'contact-2', servicePool:'Roofing',
    integration:{ base_url:'https://services.leadconnectorhq.com' }, fetchImpl:fallbackFetch,
  });
  assert.equal(fallbackResult.source, 'pool_fallback');
  assert.equal(fallbackResult.assignedDialer, 'ghl-fallback');
  assert.equal(fallbackResult.ownerUpdated, true);
  const fallbackUpdate = JSON.parse(fallbackRequests[1].options.body);
  assert.equal(fallbackUpdate.assignedTo, 'ghl-fallback');
  assert.deepEqual(fallbackUpdate.customFields, [{ id:DEFAULT_ASSIGNED_DIALER_FIELD_ID, field_value:'ghl-fallback' }]);

  const inheritedFallback = await fallbackUserForPool({
    async query(sql, params) {
      assert.ok(sql.includes("sp.source_slug IN (?, 'core')"));
      assert.deepEqual(params, ['vibedialer', 'location-1']);
      return [[{
        sourceSlug:'core', serviceType:'Remodeling', tagKeywordsJson:'["remodel","kitchen","bath","addition"]',
        userId:'owl-core-fallback', crmUserId:'ghl-core-fallback',
      }]];
    },
  }, { sourceSlug:'vibedialer', locationId:'location-1', servicePool:'kitchen' });
  assert.deepEqual(inheritedFallback, {
    userId:'owl-core-fallback', crmUserId:'ghl-core-fallback', source:'pool_fallback',
  });

  console.log('Dialer assignment tests passed');
}

function response(status, body) {
  return { ok:status >= 200 && status < 300, status, async json() { return body; } };
}

run().catch((error) => { console.error(error); process.exit(1); });
