const assert = require('assert/strict');
const { encryptSecret } = require('../src/services/secretBox');
const { DEFAULT_POOL_RULES } = require('../src/services/leadPools');
const { resetDncRateLimiter } = require('../src/services/dncScrub');
const { scrubAndPromoteDialerPhone } = require('../src/services/dialerPhoneSelection');

async function run() {
  const previousKey = process.env.DNC_SCRUB_KEY;
  const previousRetries = process.env.DNC_SCRUB_MAX_RETRIES;
  process.env.DNC_SCRUB_KEY = 'selection-test-key';
  process.env.DNC_SCRUB_MAX_RETRIES = '0';
  resetDncRateLimiter();

  const writes = [];
  const rules = DEFAULT_POOL_RULES.map((rule, index) => ({
    id:`rule-${index}`,
    source_slug:'dial',
    location_id:'location-1',
    pool_key:rule.poolKey,
    label:rule.label,
    status_values_json:JSON.stringify(rule.statusValues),
    destination_status:rule.destinationStatus,
    assignment_policy:rule.assignmentPolicy,
    is_assignable:rule.isAssignable ? 1 : 0,
    is_terminal:rule.isTerminal ? 1 : 0,
    color:rule.color,
    sort_order:rule.sortOrder,
    is_enabled:1,
  }));
  const integration = {
    id:'integration-1',
    provider:'leadconnector-pit',
    base_url:'https://services.leadconnectorhq.com',
    credential_enc:encryptSecret('test-credential'),
  };
  const connection = {
    beginTransaction:async () => writes.push({ sql:'BEGIN' }),
    commit:async () => writes.push({ sql:'COMMIT' }),
    rollback:async () => writes.push({ sql:'ROLLBACK' }),
    release:() => {},
    query:async (sql, params = []) => {
      writes.push({ sql, params });
      if (sql.startsWith('UPDATE leads')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected phone-selection transaction query: ${sql}`);
    },
  };
  const pool = {
    getConnection:async () => connection,
    query:async (sql, params = []) => {
      writes.push({ sql, params });
      if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows:0 }];
      if (sql.includes('FROM owl_lead_pool_rules WHERE')) return [rules];
      if (sql.startsWith('UPDATE crm_contact_records')) return [{ affectedRows:1 }];
      if (sql.includes('SELECT sl.lead_id,sl.external_record_id,i.*')) {
        return [[{ ...integration, lead_id:'lead-1', external_record_id:'contact-1' }]];
      }
      if (sql.includes('FROM crm_object_field_definitions')) return [[]];
      if (sql.startsWith('INSERT INTO dnc_pulse_events')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected phone-selection pool query: ${sql}`);
    },
  };

  let swapBody = null;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('dncscrub.com')) {
      assert.equal(JSON.parse(options.body).phoneList, '3125550100,7735550199,8475550188');
      return new Response(JSON.stringify([
        { Phone:'3125550100', ResultCode:'D', Reason:'National DNC' },
        { Phone:'7735550199', ResultCode:'C', Reason:'Clean' },
        { Phone:'8475550188', ResultCode:'B', Reason:'Coverage hold' },
      ]), { status:200, headers:{ 'Content-Type':'application/json' } });
    }
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'GET') {
      return new Response(JSON.stringify({ contact:{
        id:'contact-1',
        phone:'+1 312 555 0100',
        tags:['roofing'],
        customFields:[
          { id:'fixture-field-02', value:'773-555-0199' },
          { id:'fixture-field-03', value:'847-555-0188' },
        ],
      } }), { status:200, headers:{ 'Content-Type':'application/json' } });
    }
    if (method === 'PUT') swapBody = JSON.parse(options.body);
    return new Response('{}', { status:200, headers:{ 'Content-Type':'application/json' } });
  };

  try {
    const result = await scrubAndPromoteDialerPhone(pool, {
      apiKeyId:'key-1',
      locationId:'location-1',
      contactId:'contact-1',
      sourceSlug:'dial',
      operationalPool:pool,
      integration,
      fetchImpl,
      lead:{
        id:'lead-1', locationId:'location-1', status:'do_not_call', assignedTo:null,
        dncStatus:'blocked', dncResultCode:'D',
      },
    });
    assert.equal(result.approved, true);
    assert.equal(result.promoted, true);
    assert.equal(result.selectedSlot, 'alternative');
    assert.equal(result.checkedPhoneCount, 3);
    assert.equal(result.outcomes.find((item) => item.slot === 'phone3').resultCode, 'B');
    assert.equal(swapBody.phone, '773-555-0199');
    assert.deepEqual(swapBody.customFields, [
      { id:'fixture-field-02', field_value:'+1 312 555 0100' },
    ]);
    assert.ok(writes.some((entry) => entry.sql.startsWith('UPDATE leads SET dncStatus')));
    assert.ok(writes.some((entry) => entry.params?.includes('uncontacted')));
    assert.doesNotMatch(JSON.stringify(result), /3125550100|7735550199|8475550188/);
  } finally {
    resetDncRateLimiter();
    if (previousKey === undefined) delete process.env.DNC_SCRUB_KEY;
    else process.env.DNC_SCRUB_KEY = previousKey;
    if (previousRetries === undefined) delete process.env.DNC_SCRUB_MAX_RETRIES;
    else process.env.DNC_SCRUB_MAX_RETRIES = previousRetries;
  }

  console.log('Dialer phone selection tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
