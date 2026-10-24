const assert = require('assert/strict');
const { DEFAULT_POOL_RULES } = require('../src/services/leadPools');
const { rescrubDncPool } = require('../src/services/owl');

function storedRules() {
  return DEFAULT_POOL_RULES.map((item, index) => ({
    id:`pool-${index}`,
    source_slug:'core',
    location_id:'location-1',
    pool_key:item.poolKey,
    label:item.label,
    status_values_json:JSON.stringify(item.statusValues),
    destination_status:item.destinationStatus,
    assignment_policy:item.assignmentPolicy,
    is_assignable:item.isAssignable ? 1 : 0,
    is_terminal:item.isTerminal ? 1 : 0,
    color:item.color,
    sort_order:item.sortOrder,
    is_enabled:1,
  }));
}

async function run() {
  const writes = [];
  let selectedLimit = null;
  const connection = {
    beginTransaction:async () => writes.push({ sql:'BEGIN', params:[] }),
    commit:async () => writes.push({ sql:'COMMIT', params:[] }),
    rollback:async () => writes.push({ sql:'ROLLBACK', params:[] }),
    release:() => {},
    query:async (sql, params) => {
      writes.push({ sql, params });
      if (sql.startsWith('UPDATE leads SET dncLastRescrubAt')) return [{ affectedRows:3 }];
      if (sql.startsWith('UPDATE leads SET contactData')) return [{ affectedRows:1 }];
      if (sql.startsWith('UPDATE leads SET dncStatus')) return [{ affectedRows:1 }];
      if (sql.startsWith('UPDATE leads SET status')) return [{ affectedRows:1 }];
      if (sql.startsWith('INSERT INTO dnc_pulse_events')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected DNC re-scrub transaction query: ${sql}`);
    },
  };
  const pool = {
    getConnection:async () => connection,
    query:async (sql, params = []) => {
      if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows:1 }];
      if (sql.includes('FROM owl_lead_pool_rules WHERE')) return [storedRules()];
      if (sql.includes('DATE_FORMAT(CURRENT_TIMESTAMP')) return [[{ cutoff:'2026-07-13 12:00:00' }]];
      if (sql.startsWith('SELECT id FROM leads WHERE')) {
        selectedLimit = params.at(-1);
        return [[{ id:'blocked-clean' }, { id:'blocked-review' }, { id:'blocked-unresolved' }]];
      }
      if (sql.includes('SELECT id, contactData, dncStatus')) {
        return [[
          {
            id:'blocked-clean', contactData:JSON.stringify({
              phone:'3125550100',
              customFields:[
                { id:'fixture-field-02', value:'7735550199' },
                { id:'fixture-field-03', value:'8475550188' },
              ],
            }),
            dncStatus:'blocked', dncCheckedAt:'2026-06-01 10:00:00', dncSource:'dncscrub_api',
            dncResultCode:'B', dncReason:'Configured no-call area code',
            dncDecisionCategory:'configuration_or_coverage', dncReviewRequired:1,
          },
          {
            id:'blocked-review', contactData:JSON.stringify({ phone:'3125550102' }),
            dncStatus:'blocked', dncCheckedAt:'2026-06-01 10:00:00', dncSource:'dncscrub_api',
            dncResultCode:'B', dncReason:'Configured no-call area code',
            dncDecisionCategory:'configuration_or_coverage', dncReviewRequired:1,
          },
          {
            id:'blocked-unresolved', contactData:JSON.stringify({ phone:'3125550101' }),
            dncStatus:'blocked', dncCheckedAt:'2026-06-01 10:00:00', dncSource:'dncscrub_api',
            dncResultCode:'D', dncReason:'National DNC',
            dncDecisionCategory:'dnc_registry_match', dncReviewRequired:0,
          },
        ]];
      }
      if (sql.includes('FROM lead_source_links')) return [[]];
      if (sql.startsWith('SELECT COUNT(*) AS total FROM leads WHERE')) return [[{ total:0 }]];
      throw new Error(`Unexpected DNC re-scrub pool query: ${sql}`);
    },
  };

  await assert.rejects(
    () => rescrubDncPool({ source:'core', corePool:pool }, { locationId:'location-1' }),
    (error) => error.status === 400
  );

  const previousKey = process.env.DNC_SCRUB_KEY;
  const previousRetries = process.env.DNC_SCRUB_MAX_RETRIES;
  const previousFetch = global.fetch;
  let providerRequest;
  process.env.DNC_SCRUB_KEY = 'rescrub-test-key';
  process.env.DNC_SCRUB_MAX_RETRIES = '0';
  global.fetch = async (url, options) => {
    providerRequest = { url:String(url), options };
    return new Response(JSON.stringify([
      { Phone:'3125550100', ResultCode:'D', Reason:'National DNC' },
      { Phone:'7735550199', ResultCode:'C', Reason:'No DNC match' },
      { Phone:'8475550188', ResultCode:'B', Reason:'Configured no-call area code' },
      { Phone:'3125550102', ResultCode:'B', Reason:'Configured no-call area code', RegionAbbrev:'FL' },
    ]), { status:200, headers:{ 'Content-Type':'application/json' } });
  };
  try {
    const result = await rescrubDncPool({
      source:'core', apiKeyId:'key-1', corePool:pool,
    }, {
      locationId:'location-1', confirm:'RESCRUB_DNC_POOL', limit:500,
    });
    assert.equal(result.cutoff, '2026-07-13 12:00:00');
    assert.equal(selectedLimit, 50, 'a 500-lead UI request must be capped to one provider-sized batch');
    assert.equal(result.providerBatchSize, 3);
    assert.equal(result.providerBatchLimit, 50);
    assert.equal(result.providerRequestsPerMinute, 30);
    assert.equal(result.released, 1);
    assert.equal(result.stillBlocked, 0);
    assert.equal(result.heldForReview, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.remaining, 0);
    assert.equal(result.changed, 2);
    const released = result.results.find((item) => item.leadId === 'blocked-clean');
    assert.equal(released.dncStatus, 'clean');
    assert.equal(released.previous.resultCode, 'B');
    assert.equal(released.phonePromoted, true);
    assert.equal(released.selectedPhoneSlot, 'alternative');
    const review = result.results.find((item) => item.leadId === 'blocked-review');
    assert.equal(review.dncStatus, 'review');
    assert.equal(review.previous.resultCode, 'B');
    assert.equal(review.decisionCategory, 'configuration_or_coverage');
    const unresolved = result.results.find((item) => item.leadId === 'blocked-unresolved');
    assert.equal(unresolved.dncStatus, 'blocked');
    assert.equal(unresolved.previous.reason, 'National DNC');
    assert.equal(unresolved.code, 'DNC_SCRUB_RESULT_MISSING');
    assert.match(unresolved.error, /prior block remains in force/);
    assert.equal(
      JSON.parse(providerRequest.options.body).phoneList,
      '3125550100,7735550199,8475550188,3125550102,3125550101'
    );
    assert.ok(writes.some((entry) => entry.sql.startsWith('UPDATE leads SET dncLastRescrubAt')));
    const releaseRoute = writes.find((entry) => entry.sql.startsWith('UPDATE leads SET status'));
    assert.equal(releaseRoute.params[0], 'uncontacted');
    assert.match(releaseRoute.sql, /status IN/);
    assert.equal(writes.filter((entry) => entry.sql.startsWith('UPDATE leads SET dncStatus')).length, 2);
    assert.ok(writes.some((entry) => entry.params?.includes('api_rescrub_released')));
    assert.ok(writes.some((entry) => entry.params?.includes('api_rescrub_review')));
    assert.ok(writes.some((entry) => entry.params?.includes('api_rescrub_unresolved')));
    assert.doesNotMatch(JSON.stringify(result), /3125550100|7735550199|8475550188/);
    const pulseWrites = writes.filter((entry) => entry.sql.startsWith('INSERT INTO dnc_pulse_events'));
    assert.doesNotMatch(JSON.stringify(pulseWrites), /rescrub-test-key|3125550100|7735550199/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DNC_SCRUB_KEY;
    else process.env.DNC_SCRUB_KEY = previousKey;
    if (previousRetries === undefined) delete process.env.DNC_SCRUB_MAX_RETRIES;
    else process.env.DNC_SCRUB_MAX_RETRIES = previousRetries;
  }
  console.log('DNC pool re-scrub tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
