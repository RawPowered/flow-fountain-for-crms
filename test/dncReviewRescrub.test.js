const assert = require('assert/strict');
const { DEFAULT_POOL_RULES } = require('../src/services/leadPools');
const { listDncScreening, rescrubDncReviews, scrubDncScreening } = require('../src/services/owl');
const { compactDncBatchResult } = require('../src/routes/adminOwl');

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
  const compact = compactDncBatchResult({
    processed:50,
    reasonSummary:Array.from({ length:50 }, (_, index) => ({
      resultCode:'B', decisionCategory:'configuration_or_coverage',
      reason:`${index}-${'x'.repeat(255)}`, reviewRequired:true, count:1,
    })),
    results:Array.from({ length:50 }, (_, index) => ({
      leadId:`lead-${index}`, dncStatus:'review', resultCode:'B',
      resultLabel:'Configuration / coverage hold', reason:'x'.repeat(255),
      decisionCategory:'configuration_or_coverage', reviewRequired:true,
      previous:{ reason:'must not be returned in a batch response' },
    })),
  });
  assert.equal(compact.reasonSummary.length, 10);
  assert.equal(Object.hasOwn(compact.results[0], 'previous'), false);
  assert.ok(Buffer.byteLength(JSON.stringify({ ok:true, ...compact })) < 24576);

  const oversizedContacts = Array.from({ length:40 }, (_, index) => ({
    id:`lead-${String(index).padStart(3, '0')}-${'x'.repeat(115)}`,
    serviceType:'service'.repeat(20),
    contactData:JSON.stringify({
      firstName:'Name'.repeat(100), lastName:'Surname'.repeat(100),
      phone:'3125550100', email:'private@example.com', rawCrmPayload:'z'.repeat(5000),
    }),
    dncStatus:'review', dncResultCode:'B', dncReason:'reason'.repeat(100),
    dncDecisionCategory:'configuration_or_coverage'.repeat(10), dncReviewRequired:1,
    dateAdded:'2026-07-15 18:10:49',
  }));
  const compactQueuePool = {
    query:async (sql) => {
      if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows:1 }];
      if (sql.includes('FROM owl_lead_pool_rules WHERE')) return [storedRules()];
      if (sql.includes('SELECT id, serviceType, contactData')) return [oversizedContacts];
      if (sql.includes("SUM(dncStatus = 'pending')")) return [[{ total:358, pending:0, review:358, releasable:358 }]];
      throw new Error(`Unexpected compact queue query: ${sql}`);
    },
  };
  const compactQueue = await listDncScreening({
    source:'core', corePool:compactQueuePool, sourceInfo:{ tables:{ leads:{} } },
  }, { locationId:'location-1', limit:100 });
  assert.equal(compactQueue.limit, 40);
  assert.equal(compactQueue.rows.length, 40);
  assert.equal(Object.hasOwn(compactQueue.rows[0], 'contactData'), false);
  assert.equal(compactQueue.rows[0].contactName.includes('private@example.com'), false);
  assert.ok(Buffer.byteLength(JSON.stringify({ ok:true, ...compactQueue })) < 24576);

  const writes = [];
  const connection = {
    beginTransaction:async () => writes.push({ sql:'BEGIN', params:[] }),
    commit:async () => writes.push({ sql:'COMMIT', params:[] }),
    rollback:async () => writes.push({ sql:'ROLLBACK', params:[] }),
    release:() => {},
    query:async (sql, params) => {
      writes.push({ sql, params });
      if (sql.startsWith('UPDATE leads SET dncLastRescrubAt')) return [{ affectedRows:2 }];
      if (sql.startsWith('UPDATE leads SET dncStatus')) return [{ affectedRows:1 }];
      if (sql.startsWith('UPDATE leads SET status')) return [{ affectedRows:1 }];
      if (sql.startsWith('INSERT INTO dnc_pulse_events')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected review re-scrub transaction query: ${sql}`);
    },
  };
  const pool = {
    getConnection:async () => connection,
    query:async (sql) => {
      if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows:1 }];
      if (sql.includes('FROM owl_lead_pool_rules WHERE')) return [storedRules()];
      if (sql.includes('DATE_FORMAT(CURRENT_TIMESTAMP')) return [[{ cutoff:'2026-07-15 18:00:00' }]];
      if (sql.startsWith('SELECT id FROM leads WHERE')) return [[{ id:'review-clean' }, { id:'review-still' }]];
      if (sql.includes('SELECT id, contactData, dncStatus')) return [[
        {
          id:'review-clean', contactData:JSON.stringify({ phone:'3125550100' }),
          dncStatus:'review', dncCheckedAt:'2026-07-15 17:00:00', dncSource:'dncscrub_api',
          dncResultCode:'B', dncReason:';;;W', dncDecisionCategory:'configuration_or_coverage',
          dncReviewRequired:1,
        },
        {
          id:'review-still', contactData:JSON.stringify({ phone:'3125550101' }),
          dncStatus:'review', dncCheckedAt:'2026-07-15 17:00:00', dncSource:'dncscrub_api',
          dncResultCode:'B', dncReason:';;;W', dncDecisionCategory:'configuration_or_coverage',
          dncReviewRequired:1,
        },
      ]];
      if (sql.includes('FROM lead_source_links')) return [[]];
      if (sql.startsWith('SELECT COUNT(*) AS total FROM leads WHERE')) return [[{ total:0 }]];
      throw new Error(`Unexpected review re-scrub pool query: ${sql}`);
    },
  };

  await assert.rejects(
    () => rescrubDncReviews({ source:'core', corePool:pool }, { locationId:'location-1' }),
    (error) => error.status === 400
  );

  const previousKey = process.env.DNC_SCRUB_KEY;
  const previousRetries = process.env.DNC_SCRUB_MAX_RETRIES;
  const previousFetch = global.fetch;
  process.env.DNC_SCRUB_KEY = 'review-test-key';
  process.env.DNC_SCRUB_MAX_RETRIES = '0';
  global.fetch = async () => new Response(JSON.stringify([
    { Phone:'3125550100', ResultCode:'C', Reason:'No DNC match' },
    { Phone:'3125550101', ResultCode:'B', Reason:';;;W', RegionAbbrev:'FL' },
  ]), { status:200, headers:{ 'Content-Type':'application/json' } });
  try {
    const result = await rescrubDncReviews({
      source:'core', apiKeyId:'key-1', corePool:pool,
    }, {
      locationId:'location-1', confirm:'RESCRUB_DNC_REVIEWS', limit:500,
    });
    assert.equal(result.cutoff, '2026-07-15 18:00:00');
    assert.equal(result.released, 1);
    assert.equal(result.movedToDnc, 0);
    assert.equal(result.stillReview, 1);
    assert.equal(result.remaining, 0);
    assert.equal(result.providerBatchLimit, 50);
    assert.ok(writes.some((entry) => entry.sql.startsWith('UPDATE leads SET dncLastRescrubAt')));
    assert.ok(writes.some((entry) => entry.params?.includes('api_rescrub_released')));
    assert.ok(writes.some((entry) => entry.params?.includes('api_rescrub_review')));
    assert.doesNotMatch(JSON.stringify(writes), /review-test-key|3125550100|3125550101/);

    // An entirely omitted provider batch must still advance the fixed-cutoff
    // pending run; otherwise the same rows would starve everything behind them.
    const pendingWrites = [];
    const pendingConnection = {
      beginTransaction:async () => pendingWrites.push({ sql:'BEGIN', params:[] }),
      commit:async () => pendingWrites.push({ sql:'COMMIT', params:[] }),
      rollback:async () => pendingWrites.push({ sql:'ROLLBACK', params:[] }),
      release:() => {},
      query:async (sql, params) => {
        pendingWrites.push({ sql, params });
        if (sql.startsWith('UPDATE leads SET dncLastRescrubAt')) return [{ affectedRows:2 }];
        throw new Error(`Unexpected pending scrub transaction query: ${sql}`);
      },
    };
    const pendingPool = {
      getConnection:async () => pendingConnection,
      query:async (sql) => {
        if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows:1 }];
        if (sql.includes('FROM owl_lead_pool_rules WHERE')) return [storedRules()];
        if (sql.includes('DATE_FORMAT(CURRENT_TIMESTAMP')) return [[{ cutoff:'2026-07-15 18:05:00' }]];
        if (sql.startsWith('SELECT id FROM leads WHERE')) return [[{ id:'pending-1' }, { id:'pending-2' }]];
        if (sql.includes('SELECT id, contactData, dncStatus')) return [[
          { id:'pending-1', contactData:JSON.stringify({ phone:'3125550110' }), dncStatus:'pending' },
          { id:'pending-2', contactData:JSON.stringify({ phone:'3125550111' }), dncStatus:'pending' },
        ]];
        if (sql.includes('FROM lead_source_links')) return [[]];
        if (sql.includes("SUM(dncStatus = 'pending')")) return [[{ total:2, pending:2, review:0, releasable:0 }]];
        if (sql.includes('dncStatus IN (') && sql.includes('FROM leads')) return [[]];
        if (sql.startsWith('SELECT COUNT(*) AS total FROM leads WHERE')) return [[{ total:0 }]];
        throw new Error(`Unexpected pending scrub pool query: ${sql}`);
      },
    };
    global.fetch = async () => new Response('[]', {
      status:200, headers:{ 'Content-Type':'application/json' },
    });
    const pendingResult = await scrubDncScreening({
      source:'core', apiKeyId:'key-1', corePool:pendingPool,
      sourceInfo:{ tables:{ leads:{} } },
    }, { locationId:'location-1', limit:500 });
    assert.equal(pendingResult.cutoff, '2026-07-15 18:05:00');
    assert.equal(pendingResult.failed, 2);
    assert.equal(pendingResult.remaining, 0);
    assert.equal(pendingResult.providerBatchSize, 2);
    assert.ok(pendingWrites.some((entry) =>
      entry.sql.startsWith('UPDATE leads SET dncLastRescrubAt') &&
      entry.params?.includes('pending-1') && entry.params?.includes('pending-2')));
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DNC_SCRUB_KEY;
    else process.env.DNC_SCRUB_KEY = previousKey;
    if (previousRetries === undefined) delete process.env.DNC_SCRUB_MAX_RETRIES;
    else process.env.DNC_SCRUB_MAX_RETRIES = previousRetries;
  }
  console.log('DNC review re-scrub tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
