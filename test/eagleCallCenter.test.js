const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  CALL_CENTER_CONTRACT_VERSION,
  CALL_CENTER_METRIC_DEFINITIONS,
  CALL_CENTER_MINIMUM_SAMPLE,
  buildCallCenterPeriod,
  calculateExpectedMinutesElapsed,
  buildCallCenterContract,
  getCallCenter,
} = require('../src/services/eagleCallCenter');

const now = new Date('2026-07-14T16:00:00.000Z');
const period = buildCallCenterPeriod({ period:'current_week' },now);
assert.equal(period.code,'current_week');
assert.equal(period.timeZone,'America/New_York');
assert.equal(period.scheduleWeek.weekStart,'2026-07-13');
assert.throws(()=>buildCallCenterPeriod({period:'quarter'},now),/period must be/);

const aliceSchedule = { days:{ monday:[{start:'09:00',end:'17:00'}],tuesday:[{start:'09:00',end:'17:00'}] } };
assert.equal(calculateExpectedMinutesElapsed(aliceSchedule,now),660);

const rows = {
  users:[
    {id:'alice',username:'alice',crmUserName:'Alice Agent',role:'agent'},
    {id:'bob',username:'bob',crmUserName:'Bob Agent',role:'agent'},
  ],
  schedules:[{userId:'alice',scheduleData:aliceSchedule,scheduledMinutes:960,submittedAt:'2026-07-12T18:00:00Z'}],
  performanceActivity:[
    {userId:'alice',verifiedMinutes:300,engagedMinutes:240,contactsWorked:12,lastHeartbeat:'2026-07-14T15:59:00Z'},
    {userId:'bob',verifiedMinutes:120,engagedMinutes:60,contactsWorked:5,lastHeartbeat:'2026-07-14T14:00:00Z'},
  ],
  weekActivity:[
    {userId:'alice',verifiedMinutes:300,engagedMinutes:240,contactsWorked:12,lastHeartbeat:'2026-07-14T15:59:00Z'},
    {userId:'bob',verifiedMinutes:120,engagedMinutes:60,contactsWorked:5,lastHeartbeat:'2026-07-14T14:00:00Z'},
  ],
  calls:[
    {userId:'alice',confirmedCalls:20,authorizationIntents:3,eligibleLeadsWorked:10},
    {userId:'bob',confirmedCalls:5,authorizationIntents:1,eligibleLeadsWorked:5},
    {userId:null,confirmedCalls:5,authorizationIntents:2,eligibleLeadsWorked:0},
  ],
  appointments:[{userId:'alice',appointmentsBooked:3},{userId:'bob',appointmentsBooked:1}],
  appointmentYield:[{userId:'alice',appointmentsFromWorkedLeads:2},{userId:'bob',appointmentsFromWorkedLeads:0}],
  leadGroups:[
    {serviceType:'Roofing',status:'uncontacted',assignedTo:null,dncStatus:'clean',total:12,oldestLead:'2026-07-01T00:00:00Z'},
    {serviceType:'Roofing',status:'assigned',assignedTo:'alice',dncStatus:'clean',total:8},
    {serviceType:'Solar',status:'contacted',assignedTo:'bob',dncStatus:'clean',total:5},
    {serviceType:'Roofing',status:'appointment',assignedTo:'alice',dncStatus:'clean',total:2},
    {serviceType:'Roofing',status:'do_not_call',assignedTo:null,dncStatus:'blocked',total:2},
  ],
};

const contract = buildCallCenterContract({
  apiKeyId:'key-1',integrationId:'integration-1',locationId:'location-1',period,now,...rows,
});
assert.equal(contract.contractVersion,CALL_CENTER_CONTRACT_VERSION);
assert.equal(new Set(CALL_CENTER_METRIC_DEFINITIONS.map((item)=>item.metricId)).size,CALL_CENTER_METRIC_DEFINITIONS.length);
assert.ok(CALL_CENTER_METRIC_DEFINITIONS.every((item)=>item.definitionVersion==='1.0'));
assert.deepEqual(contract.minimumSample,CALL_CENTER_MINIMUM_SAMPLE);
assert.equal(contract.metrics.call_center_roster_users.value,2);
assert.equal(contract.metrics.call_center_working_now.value,1);
assert.equal(contract.metrics.call_center_schedule_submission_rate.value,50);
assert.equal(contract.metrics.call_center_submitted_hours.value,16);
assert.equal(contract.metrics.call_center_verified_hours.value,7);
assert.equal(contract.metrics.call_center_attendance_rate.value,45.5);
assert.equal(contract.metrics.call_center_engagement_rate.value,71.4);
assert.equal(contract.metrics.call_center_confirmed_calls.value,30);
assert.equal(contract.metrics.call_center_call_attribution_rate.value,83.3);
assert.equal(contract.metrics.call_center_calls_per_verified_hour.value,4.29);
assert.equal(contract.metrics.call_center_eligible_leads_worked.value,15);
assert.equal(contract.metrics.call_center_appointments_booked.value,4);
assert.equal(contract.metrics.call_center_appointment_yield.value,13.3);
assert.equal(contract.metrics.call_center_appointment_yield.status,'partial');
assert.match(contract.metrics.call_center_appointment_yield.statusReason,/event-time lead eligibility/);
assert.equal(contract.metrics.call_center_available_leads.value,12);
assert.equal(contract.metrics.call_center_active_assignment_load.value,15);
assert.equal(contract.pools.reconciliation.reconciled,true);
assert.equal(contract.pools.reconciliation.sourceTotal,29);
assert.equal(contract.agents.find((row)=>row.userId==='alice').metrics.appointment_yield.value,20);
assert.equal(contract.agents.find((row)=>row.userId==='alice').stewardshipRisk.status,'not_assessed');
assert.equal(contract.stewardship.status,'not_assessed');
assert.equal(contract.evidence.calls.authorizationIntents,6);

const unavailable = buildCallCenterContract({
  apiKeyId:'key-1',integrationId:'integration-1',locationId:'location-1',period,now,...rows,
  availability:{calls:'unavailable'},
});
assert.equal(unavailable.metrics.call_center_confirmed_calls.status,'unavailable');
assert.equal(unavailable.metrics.call_center_appointment_yield.status,'unavailable');

const routeSource = fs.readFileSync(path.join(__dirname,'..','src','routes','adminEagle.js'),'utf8');
assert.match(routeSource,/get\('\/api\/eagle\/call-center'/);
assert.match(routeSource,/eagleCallCenter\.getCallCenter/);

(async()=>{
  const pool={async query(sql){
    if(sql.includes('FROM crm_integrations i'))return [[{id:'integration-1',name:'CRM',location_id:'location-1',is_enabled:1}]];
    if(sql.includes('FROM owl_lead_pool_rules'))return [[]];
    if(sql.includes('FROM users WHERE'))return [rows.users];
    if(sql.includes('FROM user_schedule_weeks'))return [rows.schedules];
    if(sql.includes('FROM dialer_activity_minutes'))return [sql.includes(period.scheduleWeek.deadlineAt.slice(0,10))?rows.weekActivity:rows.performanceActivity];
    if(sql.includes('INNER JOIN appointments'))return [rows.appointmentYield];
    if(sql.includes('FROM lead_call_attempts'))return [rows.calls];
    if(sql.includes('FROM appointments WHERE'))return [rows.appointments];
    if(sql.includes('FROM leads WHERE'))return [rows.leadGroups];
    throw new Error(`Unexpected Call Center query: ${sql}`);
  }};
  const live=await getCallCenter({apiKeyId:'key-1',integrationId:'integration-1',period:'current_week'},pool,now);
  assert.equal(live.scope.locationId,'location-1');
  assert.equal(live.metrics.call_center_roster_users.value,2);
  assert.equal(live.evidence.pools.status,'partial');
  console.log('EAGLE Call Center contract tests passed');
})().catch((error)=>{console.error(error);process.exitCode=1;});
