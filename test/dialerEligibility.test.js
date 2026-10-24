const assert = require('assert/strict');
const { evaluateDialerEligibility, resolveDialerServicePool } = require('../src/services/dialerEligibility');

async function run() {
  const now = new Date('2026-07-13T16:00:00.000Z');
  let dncStatus = 'clean';
  let phoneMarketingStatus = 'available';
  let phone = '+15555550100';
  let contactTags = [];
  let appointment = null;
  let calendarConfigured = true;
  const statements = [];
  const assignedRule = {
    id:'rule-1', source_slug:'core', location_id:'location-1', pool_key:'assigned', label:'Assigned',
    status_values_json:'["assigned"]', destination_status:'assigned', assignment_policy:'require_user',
    is_assignable:0, is_terminal:0, color:'#3b82f6', sort_order:20, is_enabled:1,
  };
  const availableRule = {
    ...assignedRule,
    id:'rule-available', pool_key:'available', label:'Available', status_values_json:'["uncontacted"]',
    destination_status:'uncontacted', assignment_policy:'clear', is_assignable:1,
  };
  let lifecycleRule = assignedRule;
  let assignedTo = 'user-1';
  let leadStatus = 'assigned';
  const pool = { query:async (sql) => {
    statements.push(sql);
    if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows:0 }];
    if (sql.includes('FROM owl_lead_pool_rules')) return [[lifecycleRule]];
    if (sql.includes('SELECT lead_id FROM lead_source_links')) return [[{ lead_id:'lead-1' }]];
    if (sql.startsWith('SELECT id,locationId,serviceType,status')) return [[{
      id:'lead-1', locationId:'location-1', serviceType:'Roofing', status:leadStatus,
      contactData:JSON.stringify({ state:'NY', timezone:'America/New_York', phone, tags:contactTags }),
      assignedTo, dncStatus, phoneMarketingStatus,
    }]];
    if (sql.includes('FROM crm_contact_records')) return [[]];
    if (sql.includes("FROM appointments") && sql.includes("source='workbench'")) return [appointment ? [appointment] : []];
    if (sql.includes('FROM owl_service_pools')) return [calendarConfigured ? [{
      calendar_ids_json:'["calendar-1"]', default_calendar_id:'calendar-1',
    }] : []];
    if (sql.includes('FROM lead_calendar_sync_state')) return [[{
      result:'clear', external_event_id:null, retry_after_at:null, last_error_code:null, last_checked_at:now.toISOString(),
    }]];
    if (sql.startsWith('INSERT INTO lead_compliance_checks')) return [{ affectedRows:1 }];
    throw new Error(`Unexpected query: ${sql}`);
  } };

  const eligible = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, 'eligible');
  assert.equal(eligible.servicePool, 'roofing');
  assert.equal(eligible.marketingHoursEnforced, true);
  assert.equal(eligible.calendar.checked, true);
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO lead_compliance_checks')));

  const queueHoursBypassed = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
    enforceMarketingHours:false,
  });
  assert.equal(queueHoursBypassed.eligible, true);
  assert.equal(queueHoursBypassed.marketingHoursEnforced, false);

  assignedTo = null;
  lifecycleRule = availableRule;
  leadStatus = 'uncontacted';
  const unassignedQueueCandidate = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(unassignedQueueCandidate.eligible, true);
  assert.equal(unassignedQueueCandidate.assignmentRequired, false);
  assert.equal(unassignedQueueCandidate.assignmentState, 'unassigned');
  assert.equal(unassignedQueueCandidate.lifecyclePool, 'available');

  const strictUnassigned = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now, requireAssignment:true,
  });
  assert.equal(strictUnassigned.eligible, false);
  assert.equal(strictUnassigned.reason, 'not_assigned');
  assignedTo = 'user-1';
  lifecycleRule = assignedRule;
  leadStatus = 'assigned';

  dncStatus = 'pending';
  lifecycleRule = {
    ...availableRule,
    id:'rule-dnc-pending', pool_key:'dnc_pending', label:'DNC Screening',
    status_values_json:'["dnc_pending"]', destination_status:'dnc_pending', is_assignable:0,
  };
  leadStatus = 'dnc_pending';
  const pendingDnc = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(pendingDnc.eligible, false);
  assert.equal(pendingDnc.reason, 'dnc_pending');
  assert.equal(pendingDnc.lifecyclePool, 'dnc_pending');
  dncStatus = 'clean';
  lifecycleRule = assignedRule;
  leadStatus = 'assigned';

  phoneMarketingStatus = 'pending';
  const reconciledPhone = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(reconciledPhone.eligible, true);
  assert.equal(reconciledPhone.phoneMarketingStatus, 'available');
  assert.equal(reconciledPhone.phoneMarketingStatusStored, 'pending');
  assert.equal(reconciledPhone.phoneMarketingStatusSource, 'canonical_dnc_and_current_phone');

  contactTags = ['DND Phone'];
  const livePhoneDnd = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(livePhoneDnd.eligible, false);
  assert.equal(livePhoneDnd.reason, 'phone_blocked');
  assert.equal(livePhoneDnd.phoneMarketingStatusSource, 'current_crm_contact');
  contactTags = [];

  phone = '';
  const missingPhone = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(missingPhone.eligible, false);
  assert.equal(missingPhone.reason, 'phone_unavailable');
  phone = '+15555550100';

  dncStatus = 'blocked';
  const blocked = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.reason, 'dnc_blocked');

  dncStatus = 'clean';
  phoneMarketingStatus = 'blocked';
  const phoneBlocked = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(phoneBlocked.reason, 'phone_blocked');

  phoneMarketingStatus = 'available';
  appointment = {
    id:42, calendarId:'calendar-1', appointmentDate:'2026-07-14T15:00:00.000Z',
    status:'confirmed', source:'workbench', externalEventId:'event-1',
  };
  const scheduled = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(scheduled.reason, 'appointment_scheduled');

  appointment = null;
  calendarConfigured = false;
  const noCalendar = await evaluateDialerEligibility(pool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', now,
  });
  assert.equal(noCalendar.reason, 'calendar_not_configured');

  assert.equal(resolveDialerServicePool({ serviceType:'Remodeling', contactData:{ tags:['kitchen remodel'] } }), 'kitchen');
  assert.equal(resolveDialerServicePool({ serviceType:'Remodeling', contactData:{ Keywords:'Bathroom Remodel' } }), 'bathroom');
  assert.equal(resolveDialerServicePool({ serviceType:'Remodeling', contactData:{ tags:['home addition'] } }), 'home_addition');
  assert.equal(resolveDialerServicePool({ serviceType:'Remodeling', contactData:{ tags:['mold remediation'] } }), 'mold');
  assert.equal(resolveDialerServicePool({ serviceType:'Remodeling', contactData:{ tags:[] } }), null);

  console.log('Dialer eligibility tests passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
