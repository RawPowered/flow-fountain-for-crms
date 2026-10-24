const assert = require('assert/strict');
const { DEFAULT_POOL_RULES } = require('../src/services/leadPools');
const { releaseDncReviews } = require('../src/services/owl');
const { applyDncScreeningStatus } = require('../src/services/crmImporter');

function storedRules() {
  return DEFAULT_POOL_RULES.map((item, index) => ({
    id:`pool-${index}`, source_slug:'core', location_id:'location-1',
    pool_key:item.poolKey, label:item.label,
    status_values_json:JSON.stringify(item.statusValues),
    destination_status:item.destinationStatus, assignment_policy:item.assignmentPolicy,
    is_assignable:item.isAssignable ? 1 : 0, is_terminal:item.isTerminal ? 1 : 0,
    color:item.color, sort_order:item.sortOrder, is_enabled:1,
  }));
}

async function run() {
  const writes = [];
  const candidates = [
    { id:'review-b-1', dncResultCode:'B', dncReason:';;;W',
      dncDecisionCategory:'configuration_or_coverage', dncReviewRequired:1 },
    { id:'review-b-2', dncResultCode:'B', dncReason:null,
      dncDecisionCategory:'configuration_or_coverage', dncReviewRequired:1 },
  ];
  const connection = {
    beginTransaction:async () => writes.push({ sql:'BEGIN', params:[] }),
    commit:async () => writes.push({ sql:'COMMIT', params:[] }),
    rollback:async () => writes.push({ sql:'ROLLBACK', params:[] }),
    release:() => {},
    query:async (sql, params) => {
      writes.push({ sql, params });
      if (sql.startsWith('SELECT id,dncResultCode')) return [candidates];
      if (sql.startsWith("UPDATE leads SET dncStatus = 'clean'")) return [{ affectedRows:2 }];
      if (sql.startsWith('INSERT INTO dnc_pulse_events')) return [{ affectedRows:2 }];
      throw new Error(`Unexpected DNC review release transaction query: ${sql}`);
    },
  };
  const pool = {
    getConnection:async () => connection,
    query:async (sql) => {
      if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows:1 }];
      if (sql.includes('FROM owl_lead_pool_rules WHERE')) return [storedRules()];
      if (sql.startsWith('SELECT COUNT(*) AS total FROM leads')) return [[{ total:0 }]];
      if (sql.includes('FROM lead_source_links sl')) return [[]];
      throw new Error(`Unexpected DNC review release pool query: ${sql}`);
    },
  };
  const context = { source:'core', apiKeyId:'key-1', corePool:pool };

  await assert.rejects(
    () => releaseDncReviews(context, {
      locationId:'location-1', releaseReason:'Florida provider configuration override',
    }),
    (error) => error.status === 400
  );
  await assert.rejects(
    () => releaseDncReviews(context, {
      locationId:'location-1', confirm:'RELEASE_DNC_B_REVIEWS', releaseReason:'short',
    }),
    (error) => error.status === 400
  );

  const result = await releaseDncReviews(context, {
    locationId:'location-1', confirm:'RELEASE_DNC_B_REVIEWS', limit:500,
    releaseReason:'Florida provider B configuration/coverage hold released by administrator',
  });
  assert.equal(result.released, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.destinationPool, 'available');
  assert.equal(result.destinationStatus, 'uncontacted');
  assert.equal(result.eligibleResultCode, 'B');
  assert.equal(result.crmSync.skipped, 2);

  const selection = writes.find((entry) => entry.sql.startsWith('SELECT id,dncResultCode'));
  assert.match(selection.sql, /dncStatus = 'review'/);
  assert.match(selection.sql, /dncResultCode = 'B'/);
  assert.match(selection.sql, /dncDecisionCategory = 'configuration_or_coverage'/);
  assert.doesNotMatch(selection.sql, /dncResultCode IN/);

  const update = writes.find((entry) => entry.sql.startsWith("UPDATE leads SET dncStatus = 'clean'"));
  assert.ok(update);
  assert.match(update.sql, /dncSource = 'owl_review_override'/);
  assert.match(update.sql, /dncDecisionCategory = 'manual_configuration_override'/);
  assert.equal(update.params[0], 'uncontacted');
  const setClause = update.sql.split('WHERE')[0];
  assert.doesNotMatch(setClause, /dncResultCode/);
  assert.doesNotMatch(setClause, /dncReason/);
  assert.ok(writes.some((entry) => entry.params?.includes('manual_review_release')));
  assert.ok(writes.some((entry) => entry.sql === 'COMMIT'));
  assert.ok(!writes.some((entry) => entry.sql === 'ROLLBACK'));

  let evidenceGuardSql = '';
  await applyDncScreeningStatus({
    query:async (sql) => {
      evidenceGuardSql = sql;
      return [{ affectedRows:0 }];
    },
  }, 'review-b-1', 'location-1', { state:'clean' }, storedRules(), {
    source:'crm_tags', resultCode:'C', expectedDncStatus:'clean',
  });
  assert.match(evidenceGuardSql, /NOT IN \('dncscrub_api','owl_review_override'\)/);

  console.log('DNC B-review release tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
