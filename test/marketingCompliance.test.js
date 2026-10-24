const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const { encryptSecret } = require('../src/services/secretBox');
const { setPool } = require('../src/db/pool');
const { createLeadManagementRouter } = require('../src/routes/api/leads');
const {
  resolveLeadJurisdiction,
  evaluateMarketingWindow,
  outboundCalls,
  storeCrmAttempts,
  attemptStats,
  fetchCrmCallAttempts,
  fetchTimeZoneByCoordinates,
  leadCoordinates,
  resolveCoordinateTimeZone,
  screenLeadCandidates,
  resolveComplianceLead,
  authorizeCallAttempt,
} = require('../src/services/marketingCompliance');

async function run() {
  assert.deepEqual(resolveLeadJurisdiction({ state:'NY' }), {
    stateCode:'NY', timeZone:'America/New_York', timeZoneSource:'state_fallback',
  });
  assert.equal(resolveLeadJurisdiction({ state:'Florida' }).timeZone, null);
  assert.equal(resolveLeadJurisdiction({ state:'FL', timezone:'EST' }).timeZone, 'America/New_York');
  assert.equal(resolveLeadJurisdiction({ state:'FL', timezone:'UTC' }).timeZone, null);
  assert.equal(resolveLeadJurisdiction({ state:'FL', timezone:'America/Chicago' }).timeZone, 'America/Chicago');
  assert.equal(resolveLeadJurisdiction({ state:'NY', timezone:'UTC' }).timeZone, 'America/New_York');
  assert.equal(resolveLeadJurisdiction({ state:'TX', timezone:'UTC' }).timeZone, null);
  assert.equal(resolveLeadJurisdiction({ state:'TX', timezone:'America/Chicago' }).timeZone, 'America/Chicago');
  assert.deepEqual(leadCoordinates({ geo:{ latitude:'27.9506', longitude:'-82.4572' } }), {
    latitude:27.9506, longitude:-82.4572,
  });

  let timeZoneRequests = 0;
  const timeZoneFetch = async (url, options) => {
    timeZoneRequests += 1;
    assert.equal(url.origin, 'https://timeapi.io');
    assert.equal(url.pathname, '/api/timezone/coordinate');
    assert.equal(url.searchParams.get('latitude'), '27.950600');
    assert.equal(url.searchParams.get('longitude'), '-82.457200');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ timeZone:'America/New_York' }), {
      status:200, headers:{ 'Content-Type':'application/json' },
    });
  };
  assert.equal(await fetchTimeZoneByCoordinates(27.9506, -82.4572, timeZoneFetch), 'America/New_York');
  assert.equal(timeZoneRequests, 1);

  const opening = evaluateMarketingWindow({ state:'NY' }, new Date('2026-07-11T12:00:00Z'));
  assert.equal(opening.allowed, true);
  assert.equal(opening.localTime, '2026-07-11 08:00:00');
  const closing = evaluateMarketingWindow({ state:'NY' }, new Date('2026-07-11T23:00:00Z'));
  assert.equal(closing.allowed, false);
  assert.equal(closing.reason, 'outside_marketing_hours');
  assert.equal(closing.nextEligibleAt, '2026-07-12T12:00:00.000Z');
  const floridaConservative = evaluateMarketingWindow({ state:'FL' }, new Date('2026-07-11T16:00:00Z'));
  assert.equal(floridaConservative.allowed, true);
  assert.equal(floridaConservative.timeZoneSource, 'state_conservative_overlap');
  const reportedIncident = evaluateMarketingWindow(
    { state:'FL', timezone:'UTC' },
    new Date('2026-07-13T19:55:07.516Z')
  );
  assert.equal(reportedIncident.allowed, true);
  assert.equal(reportedIncident.localTime, '2026-07-13 15:55:07');
  assert.equal(reportedIncident.timeZoneSource, 'state_conservative_overlap');
  const floridaTooEarlyForEitherZone = evaluateMarketingWindow(
    { state:'FL', timezone:'UTC' },
    new Date('2026-07-13T12:30:00Z')
  );
  assert.equal(floridaTooEarlyForEitherZone.allowed, false);
  assert.equal(floridaTooEarlyForEitherZone.nextEligibleAt, '2026-07-13T13:00:00.000Z');
  const texasEvening = evaluateMarketingWindow(
    { state:'TX', timezone:'UTC' },
    new Date('2026-07-16T00:50:37Z')
  );
  assert.equal(texasEvening.allowed, false);
  assert.equal(texasEvening.localTime, '2026-07-15 19:50:37');
  assert.equal(texasEvening.timeZoneSource, 'state_conservative_overlap');
  assert.equal(texasEvening.nextEligibleAt, '2026-07-16T14:00:00.000Z');
  assert.equal(evaluateMarketingWindow(
    { state:'TX', timezone:'UTC' },
    new Date('2026-07-16T14:00:00Z')
  ).allowed, true);
  const winterOpening = evaluateMarketingWindow({ state:'NY' }, new Date('2026-01-07T13:00:00Z'));
  assert.equal(winterOpening.allowed, true);

  const originalTimeZoneFetch = global.fetch;
  const timeZoneQueries = [];
  global.fetch = timeZoneFetch;
  try {
    const resolvedTimeZone = await resolveCoordinateTimeZone({
      query:async (sql, params) => {
        timeZoneQueries.push({ sql, params });
        if (sql.includes('SELECT time_zone FROM lead_timezone_cache')) return [[]];
        if (sql.startsWith('INSERT INTO lead_timezone_cache')) return [{ affectedRows:1 }];
        throw new Error(`Unexpected timezone cache query: ${sql}`);
      },
    }, {
      id:'lead-tz-1', locationId:'location-1',
      contactData:{ state:'FL', latitude:27.9506, longitude:-82.4572 },
    });
    assert.deepEqual(resolvedTimeZone, {
      timeZone:'America/New_York', source:'coordinate_api', latitude:27.9506, longitude:-82.4572,
    });
    assert.ok(timeZoneQueries.some((item) => item.sql.startsWith('INSERT INTO lead_timezone_cache')));
  } finally { global.fetch = originalTimeZoneFetch; }

  const now = new Date('2026-07-11T18:00:00Z');
  const calls = outboundCalls([
    { direction:'outbound', messageType:'CALL', messageId:'call-1', dateAdded:'2026-07-11T17:00:00Z', status:'completed', userId:'crm-user-1' },
    { direction:'outbound', messageTypeString:'TYPE_CALL', messageId:'call-2', dateAdded:'2026-07-10T19:00:00Z', callStatus:'no-answer' },
    { direction:'outbound', messageType:'CALL', messageId:'not-dialed', dateAdded:'2026-07-11T17:30:00Z', status:'queued' },
    { direction:'inbound', messageType:'CALL', messageId:'call-3', dateAdded:'2026-07-11T17:00:00Z' },
    { direction:'outbound', messageType:'SMS', messageId:'sms-1', dateAdded:'2026-07-11T17:00:00Z' },
    { direction:'outbound', messageType:'CALL', messageId:'old', dateAdded:'2026-07-10T17:59:59Z' },
  ], now);
  assert.deepEqual(calls.map((item) => item.eventId), ['call-1', 'call-2']);
  assert.equal(calls[0].externalUserId, 'crm-user-1');
  assert.equal(calls[1].status, 'no_answer');

  process.env.SESSION_SECRET = 'marketing-compliance-test-secret';
  const integration = {
    id:'integration-1', provider:'leadconnector-pit', location_id:'location-1',
    base_url:'https://services.leadconnectorhq.com', auth_scheme:'Bearer',
    credential_enc:encryptSecret('pit-token'), config_json:'{}', external_record_id:'contact-1',
  };
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url:String(url), options });
    if (String(url).includes('/conversations/search')) {
      return new Response(JSON.stringify({ conversations:[{ id:'conversation-1', contactId:'contact-1' }] }), { status:200 });
    }
    return new Response(JSON.stringify({ messages:{ messages:[
      { direction:'outbound', messageType:'CALL', messageId:'crm-call-1', dateAdded:'2026-07-11T17:30:00Z', status:'completed' },
    ] } }), { status:200 });
  };
  try {
    const attempts = await fetchCrmCallAttempts(integration, 'contact-1', now);
    assert.equal(attempts.length, 1);
    assert.match(requests[0].url, /contactId=contact-1/);
    assert.match(requests[1].url, /conversations\/conversation-1\/messages/);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer pit-token');
    assert.equal(requests[0].options.headers.Version, 'v3');
  } finally { global.fetch = originalFetch; }

  const stored = [];
  await storeCrmAttempts({ query:async (sql, params) => {
    if (sql.includes('SELECT id,crmUserId FROM users')) return [[{ id:'user-1', crmUserId:'crm-user-1' }]];
    if (sql.startsWith('INSERT INTO lead_call_attempts')) { stored.push({ sql, params }); return [{ affectedRows:1 }]; }
    throw new Error(`Unexpected CRM attempt query: ${sql}`);
  } }, { id:'lead-1', locationId:'location-1', serviceType:'Roofing', assignedTo:'different-user' }, integration, [
    { eventId:'result-1', occurredAt:'2026-07-11T17:00:00Z', status:'completed', externalUserId:'crm-user-1' },
    { eventId:'result-2', occurredAt:'2026-07-11T17:05:00Z', status:'busy', externalUserId:'unmapped-crm-user' },
  ]);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].params[3], 'user-1');
  assert.equal(stored[0].params[4], 'crm-user-1');
  assert.equal(stored[1].params[3], null);
  assert.equal(stored[1].params[4], 'unmapped-crm-user');
  assert.ok(stored.every((item) => item.sql.includes("'crm'")));
  const stats = await attemptStats({ query:async (sql) => {
    assert.ok(sql.includes("source = 'crm'"), 'attempt limits must only count final CRM evidence');
    return [[{ total:2, oldest:'2026-07-11 17:00:00.000' }]];
  } }, 'lead-1', now);
  assert.equal(stats.total, 2);

  const statements = [];
  const pool = { query:async (sql) => { statements.push(sql); if (sql.startsWith('INSERT INTO lead_compliance_checks')) return [{ affectedRows:1 }]; throw new Error(`Unexpected query: ${sql}`); } };
  const screened = await screenLeadCandidates(pool, {
    apiKeyId:'key-1', locationId:'location-1', userId:'user-1', now:new Date('2026-07-11T23:00:00Z'),
    leads:[{ id:'lead-1', locationId:'location-1', serviceType:'Roofing', contactData:JSON.stringify({ state:'NY' }) }],
  });
  assert.equal(screened.eligible.length, 0);
  assert.equal(screened.blocked[0].compliance.reason, 'outside_marketing_hours');
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO lead_compliance_checks')));
  const queueScreened = await screenLeadCandidates(pool, {
    apiKeyId:'key-1', locationId:'location-1', userId:'user-1', now:new Date('2026-07-11T23:00:00Z'),
    enforceMarketingHours:false,
    leads:[{ id:'lead-1', locationId:'location-1', serviceType:'Roofing', contactData:JSON.stringify({ state:'NY' }) }],
  });
  assert.equal(queueScreened.eligible.length, 1);
  assert.equal(queueScreened.blocked.length, 0);

  const floridaRequests = [];
  global.fetch = async (url) => {
    floridaRequests.push(String(url));
    if (String(url).includes('/conversations/search')) {
      return new Response(JSON.stringify({ conversations:[{ id:'conversation-fl', contactId:'contact-fl' }] }), { status:200 });
    }
    return new Response(JSON.stringify({ messages:{ messages:[
      { direction:'outbound', messageType:'CALL', messageId:'fl-call-1', dateAdded:'2026-07-11T18:00:00Z', status:'completed' },
      { direction:'outbound', messageType:'CALL', messageId:'fl-call-2', dateAdded:'2026-07-11T19:00:00Z', status:'completed' },
      { direction:'outbound', messageType:'CALL', messageId:'fl-call-3', dateAdded:'2026-07-11T20:00:00Z', status:'completed' },
    ] } }), { status:200 });
  };
  try {
    const floridaPool = { query:async (sql) => {
      if (sql.includes('FROM lead_source_links sl')) return [[{ ...integration, lead_id:'lead-fl', external_record_id:'contact-fl' }]];
      if (sql.includes('SELECT id,crmUserId FROM users')) return [[]];
      if (sql.startsWith('INSERT INTO lead_call_attempts')) return [{ affectedRows:1 }];
      if (sql.startsWith('SELECT COUNT(*) AS total')) return [[{ total:3, oldest:'2026-07-11 18:00:00.000' }]];
      if (sql.startsWith('INSERT INTO lead_compliance_checks')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected Florida queue query: ${sql}`);
    } };
    const floridaQueueScreened = await screenLeadCandidates(floridaPool, {
      apiKeyId:'key-1', locationId:'location-1', userId:'user-1', now:new Date('2026-07-12T01:00:00Z'),
      enforceMarketingHours:false,
      leads:[{ id:'lead-fl', locationId:'location-1', serviceType:'Roofing', contactData:{ state:'FL', timezone:'America/New_York' } }],
    });
    assert.equal(floridaQueueScreened.eligible.length, 0);
    assert.equal(floridaQueueScreened.blocked[0].compliance.reason, 'florida_attempt_limit');
    assert.equal(floridaQueueScreened.blocked[0].compliance.nextEligibleAt, '2026-07-12T18:00:00.000Z');
    assert.ok(floridaRequests.some((url) => url.includes('/conversations/search')));
  } finally { global.fetch = originalFetch; }

  const complianceQueries = [];
  let complianceRecord = { state:'NY', timezone:'America/New_York' };
  const complianceConnection = {
    beginTransaction:async () => {}, commit:async () => {}, rollback:async () => {}, release:() => {},
    query:async (sql) => {
      complianceQueries.push(sql);
      if (sql.startsWith('SELECT id FROM leads')) return [[{ id:'lead-1' }]];
      if (sql.startsWith('SELECT COUNT(*) AS total')) return [[{ total:0, oldest:null }]];
      if (sql.startsWith('INSERT INTO lead_call_attempts')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected compliance connection query: ${sql}`);
    },
  };
  const compliancePool = {
    getConnection:async () => complianceConnection,
    query:async (sql, params) => {
      complianceQueries.push(sql);
      if (sql.includes('SELECT lead_id FROM lead_source_links')) return [[{ lead_id:'lead-1' }]];
      if (sql.startsWith('SELECT id,locationId,serviceType')) return [[{
        id:'lead-1', locationId:'location-1', serviceType:'Roofing',
        contactData:JSON.stringify({ firstName:'Ada' }), assignedTo:'user-1', dncStatus:'clean',
      }]];
      if (sql.includes('SELECT payload_json FROM crm_contact_records')) {
        return [[{ payload_json:JSON.stringify(complianceRecord) }]];
      }
      if (sql.includes("FROM appointments") && sql.includes("source='workbench'")) return [[]];
      if (sql.includes('FROM owl_service_pools')) return [[]];
      if (sql.includes('FROM lead_source_links sl')) return [[]];
      if (sql.startsWith('INSERT INTO lead_compliance_checks')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected compliance pool query: ${sql} ${JSON.stringify(params)}`);
    },
  };
  const resolved = await resolveComplianceLead(compliancePool, {
    locationId:'location-1', contactId:'contact-1',
  });
  assert.equal(resolved.id, 'lead-1');
  assert.equal(resolveLeadJurisdiction(resolved.contactData).stateCode, 'NY');
  let operationalLeadRead = false;
  const bridgedLead = await resolveComplianceLead({ query:async (sql) => {
    if (sql.includes('SELECT lead_id FROM lead_source_links')) return [[{ lead_id:'lead-external' }]];
    if (sql.includes('SELECT payload_json FROM crm_contact_records')) return [[{ payload_json:'{"state":"NY"}' }]];
    throw new Error(`Unexpected control-plane query: ${sql}`);
  } }, {
    locationId:'location-1', contactId:'contact-external',
    operationalPool:{ query:async (sql) => {
      assert.ok(sql.startsWith('SELECT id,locationId,serviceType'));
      operationalLeadRead = true;
      return [[{ id:'lead-external', locationId:'location-1', serviceType:'Roofing', contactData:'{}', assignedTo:'user-1', dncStatus:'clean' }]];
    } },
  });
  assert.equal(bridgedLead.id, 'lead-external');
  assert.equal(operationalLeadRead, true);
  const fallbackPool = {
    query:async (sql) => {
      if (sql.includes('SELECT lead_id FROM lead_source_links')) return [[{ lead_id:'lead-2' }]];
      if (sql.startsWith('SELECT id,locationId,serviceType')) return [[{
        id:'lead-2', locationId:'location-1', serviceType:'Roofing', contactData:'{}',
        assignedTo:'user-1', dncStatus:'clean',
      }]];
      if (sql.includes('SELECT payload_json FROM crm_contact_records')) return [[]];
      if (sql.includes('FROM lead_import_values')) return [[
        { field_key:'contact.state', data_type:'string', value_text:'FL' },
        { field_key:'contact.timezone', data_type:'string', value_text:'America/New_York' },
      ]];
      throw new Error(`Unexpected compliance fallback query: ${sql}`);
    },
  };
  const fallbackLead = await resolveComplianceLead(fallbackPool, {
    locationId:'location-1', contactId:'contact-2',
  });
  assert.deepEqual(resolveLeadJurisdiction(fallbackLead.contactData), {
    stateCode:'FL', timeZone:'America/New_York', timeZoneSource:'crm',
  });
  const authorization = await authorizeCallAttempt(compliancePool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', userId:'user-1',
    occurredAt:new Date('2026-07-11T16:00:00Z'),
  });
  assert.equal(authorization.allowed, true);
  assert.ok(authorization.id);
  assert.ok(complianceQueries.some((sql) => sql.includes('crm_contact_records')));

  const routePool = {
    getConnection:compliancePool.getConnection,
    query:async (sql, params) => {
      if (sql.includes('FROM api_operator_sessions s')) return [[{
        apiKeyId:'key-1', userId:'user-1', locationId:'location-1', isAdmin:0,
        expiresAt:'2026-07-12 18:30:00.000', username:'agent', crmUserName:'Agent',
      }]];
      if (sql.startsWith('UPDATE api_operator_sessions SET last_used_at')) return [{ affectedRows:1 }];
      if (sql.includes('COUNT(DISTINCT i.id)')) return [[{ integration_count:1, grant_count:1 }]];
      if (sql.startsWith('SELECT id FROM users')) return [[{ id:'user-1' }]];
      if (sql.includes('FROM user_schedule_weeks')) return [[{
        userId:'user-1', locationId:'location-1', scheduleData:'{}', submittedAt:'2026-07-12 01:00:00',
      }]];
      return compliancePool.query(sql, params);
    },
  };
  const desiredOffset = 12 - new Date().getUTCHours();
  complianceRecord = {
    state:'KS',
    timezone:desiredOffset === 0 ? 'UTC' : `Etc/GMT${desiredOffset > 0 ? '-' : '+'}${Math.abs(desiredOffset)}`,
  };
  setPool(routePool);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.apiKey = { id:'key-1' }; next(); });
  app.use('/api/leads', createLeadManagementRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/leads/call-attempts/authorize`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-Operator-Token':'A'.repeat(43) },
      body:JSON.stringify({ contactId:'contact-1' }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['allowed', 'authorizationId', 'success']);
    assert.equal(body.allowed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setPool(null);
  }

  console.log('Marketing compliance tests passed');
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
