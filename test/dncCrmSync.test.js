const assert = require('assert/strict');
const { encryptSecret } = require('../src/services/secretBox');
const { buildCustomFields, syncDncResultsToCrm } = require('../src/services/dncCrmSync');

async function run() {
  const fields = buildCustomFields([
    { field_id:'result-id', field_name:'DNC Scrub Result' },
    { field_id:'status-id', field_name:'DNC Scrub Status' },
    { field_id:'checked-id', field_name:'DNC Last Scrubbed' },
    { field_id:'reason-id', field_name:'DNC Scrub Reason' },
    { field_id:'line-id', field_name:'DNC Line Type' },
  ], {
    dncStatus:'clean', resultCode:'W', resultLabel:'Wireless', reason:'Callable wireless', lineType:'Wireless',
  }, '2026-07-14T08:00:00.000Z');
  assert.deepEqual(fields, [
    { id:'result-id', field_value:'W' },
    { id:'status-id', field_value:'Wireless' },
    { id:'checked-id', field_value:'2026-07-14T08:00:00.000Z' },
    { id:'reason-id', field_value:'Callable wireless' },
    { id:'line-id', field_value:'Wireless' },
  ]);

  const writes = [];
  const pool = { query:async (sql, params) => {
    if (sql.includes('FROM lead_source_links sl')) return [[{
      lead_id:'lead-1', external_record_id:'contact-1', id:'integration-1',
      provider:'leadconnector-pit', location_id:'location-1', base_url:'https://services.leadconnectorhq.com',
      credential_enc:encryptSecret('private-token'), auth_scheme:'Bearer',
    }]];
    if (sql.includes('FROM crm_object_field_definitions')) return [[
      { field_id:'result-id', field_name:'DNC Scrub Result', field_key:'contact.dnc_scrub_result' },
      { field_id:'status-id', field_name:'DNC Scrub Status', field_key:'contact.dnc_scrub_status' },
    ]];
    if (sql.startsWith('INSERT INTO dnc_pulse_events')) return [{ affectedRows:1 }];
    throw new Error(`Unexpected DNC CRM sync query: ${sql} ${JSON.stringify(params)}`);
  } };
  const result = {
    leadId:'lead-1', dncStatus:'clean', source:'dncscrub_api', resultCode:'C',
    resultLabel:'Clean', reason:'Approved alternate',
  };
  Object.defineProperty(result, 'phoneAudit', { enumerable:false, value:{
    promoted:true,
    selectedSlot:'alternative',
    selectedFieldId:'fixture-field-02',
    selectedRaw:'7735550199',
    previousPrimaryRaw:'3125550100',
    entries:[
      { slot:'primary', phone:'3125550100', resultCode:'D', resultLabel:'Do Not Call', state:'blocked' },
      { slot:'alternative', phone:'7735550199', resultCode:'C', resultLabel:'Clean', state:'clean' },
      { slot:'phone3', phone:'8475550188', resultCode:'B', resultLabel:'Configuration / coverage hold', state:'review' },
    ],
  } });
  const summary = await syncDncResultsToCrm(pool, {
    apiKeyId:'key-1', locationId:'location-1', results:[result], now:new Date('2026-07-14T08:00:00Z'),
    fetchImpl:async (url, options) => {
      writes.push({ url:String(url), method:options.method, headers:options.headers, body:JSON.parse(options.body) });
      return new Response('{}', { status:200 });
    },
  });
  assert.deepEqual(summary, { synced:1, failed:0, skipped:0 });
  assert.equal(result.crmSync.status, 'synced');
  assert.equal(writes.length, 4);
  assert.equal(writes[0].body.phone, '7735550199');
  assert.deepEqual(writes[0].body.customFields, [
    { id:'fixture-field-02', field_value:'3125550100' },
    { id:'result-id', field_value:'C' },
    { id:'status-id', field_value:'Clean' },
  ]);
  assert.deepEqual(writes[1].body.tags, ['dnc-clean']);
  assert.deepEqual(writes[2].body.tags, ['dnc-blocked', 'dnc-review', 'dnc-pending']);
  assert.match(writes[3].url, /\/contacts\/contact-1\/notes$/);
  assert.match(writes[3].body.body, /Primary Phone: \(312\) 555-0100 - D \(Do Not Call\)/);
  assert.match(writes[3].body.body, /Alternative Phone: \(773\) 555-0199 - C \(Clean\) - promoted to Primary Phone/);
  assert.match(writes[3].body.body, /Phone 3: \(847\) 555-0188 - B \(Configuration \/ coverage hold\)/);
  assert.equal(result.crmSync.phonePromoted, true);
  assert.equal(result.crmSync.noteAdded, true);
  assert.equal(writes[0].headers.Authorization, 'Bearer private-token');
  assert.doesNotMatch(JSON.stringify(result.crmSync), /private-token/);
  assert.doesNotMatch(JSON.stringify(result), /3125550100|7735550199|8475550188/);

  let attempts = 0;
  const retryResult = { leadId:'lead-1', dncStatus:'clean', source:'dncscrub_api', resultCode:'C', resultLabel:'Clean' };
  const retrySummary = await syncDncResultsToCrm(pool, {
    apiKeyId:'key-1', locationId:'location-1', results:[retryResult], maxAttempts:2, sleep:async () => {},
    fetchImpl:async () => {
      attempts += 1;
      return new Response('{}', { status:attempts === 1 ? 503 : 200 });
    },
  });
  assert.equal(retrySummary.synced, 1);
  assert.ok(attempts >= 4, 'the first CRM request should retry before tag reconciliation continues');

  console.log('DNC CRM write-back tests passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
