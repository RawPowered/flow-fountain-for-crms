const assert = require('assert/strict');
require('./eagleValidation.test');
require('./eagleExecutive.test');
require('./eagleTargets.test');
const fs = require('fs');
const path = require('path');
const { SCHEMA_VERSION } = require('../src/config');
const {
  EAGLE_METRIC_DEFINITIONS, normalizeOpportunityRecord, syncLeadEventsForSnapshot,
  importOpportunitySnapshots, getHistoricalFunnel,
} = require('../src/services/eagle');

const won = normalizeOpportunityRecord({
  opportunityId:'opp-1', contactId:'contact-1', status:'won', wonAt:'2026-07-10T18:00:00Z',
  openedAt:'2026-07-01T14:00:00Z', monetaryValue:'12500.50', stageName:'Closed Won',
}, 0, true);
assert.equal(won.status, 'won');
assert.equal(won.wonAt, '2026-07-10 18:00:00');
assert.equal(won.monetaryValue, 12500.5);
assert.throws(() => normalizeOpportunityRecord({ opportunityId:'opp-2',contactId:'c2',status:'won' },0,true), /requires wonAt/);
assert.throws(() => normalizeOpportunityRecord({ opportunityId:'opp-3',contactId:'c3',status:'maybe' }), /open, won, or lost/);
assert.ok(EAGLE_METRIC_DEFINITIONS.some((item) => item.metricId === 'lead_to_appointment_rate'));
assert.ok(EAGLE_METRIC_DEFINITIONS.some((item) => item.metricId === 'lead_to_win_rate'));

(async () => {
  const syncCalls = [];
  const synced = await syncLeadEventsForSnapshot({ id:'integration-1' }, 'snapshot-1', {
    async query(sql, params) {
      syncCalls.push({ sql, params });
      if (sql.includes('SELECT event_type')) return [[{ event_type:'lead_created',total:10 },{ event_type:'appointment_booked',total:3 }]];
      return [[]];
    },
  });
  assert.equal(synced.appointment_booked, 3);
  assert.ok(syncCalls.some((call) => call.sql.includes("'appointment_booked'")));
  assert.ok(syncCalls.some((call) => call.sql.includes('ON DUPLICATE KEY UPDATE')));

  const importCalls = [];
  const imported = await importOpportunitySnapshots({
    snapshotId:'snapshot-1',apiKeyId:'key-1',sourceSystem:'crm-opportunities',isComplete:true,
    records:[{ opportunityId:'opp-1',contactId:'contact-1',status:'won',wonAt:'2026-07-10T18:00:00Z' }],
  }, { id:'admin-1' }, {
    async query(sql, params) {
      importCalls.push({ sql, params });
      if (sql.includes('FROM eagle_snapshots')) return [[{
        id:'snapshot-1',integrationId:'integration-1',apiKeyId:'key-1',locationId:'location-1',status:'completed',
        completedAt:'2026-07-12T22:30:00Z',eventsSyncedAt:'2026-07-12T22:30:00Z',
      }]];
      return [[]];
    },
  });
  assert.equal(imported.recordsReceived, 1);
  assert.equal(imported.recordsWithWonAt, 1);
  assert.ok(importCalls.some((call) => call.sql.includes('INSERT INTO eagle_opportunity_snapshots')));
  assert.ok(importCalls.some((call) => call.sql.includes("'opportunity_import'")));

  const historical = await getHistoricalFunnel(
    { snapshotId:'snapshot-1',integrationId:'integration-1',days:30 },
    { id:'snapshot-1',integrationId:'integration-1',eventsSyncedAt:'2026-07-12T22:30:00Z' },
    '2026-07-12T22:30:00Z', 12,
    { async query(sql, params) {
      if (sql.includes('FROM eagle_outcome_imports')) return [[]];
      if (sql.includes('FROM eagle_lead_events e') && sql.includes('GROUP BY DATE')) return [[{ date:'2026-07-10',appointments:2,wins:0 }]];
      if (sql.includes('COUNT(*) AS eligible')) {
        const previous = params.includes(60);
        return [[previous ? { eligible:8,appointed:2,won:0 } : { eligible:10,appointed:3,won:0 }]];
      }
      throw new Error(`Unexpected historical query: ${sql}`);
    } }
  );
  assert.equal(historical.metrics.lead_to_appointment_rate.status, 'available');
  assert.equal(historical.metrics.lead_to_appointment_rate.value, 30);
  assert.equal(historical.metrics.lead_to_win_rate.status, 'unavailable');
  assert.equal(historical.wonLeads, null);
  assert.equal(historical.trend[0].wins, null);

  const historicalWithWins = await getHistoricalFunnel(
    { snapshotId:'snapshot-1',integrationId:'integration-1',days:30 },
    { id:'snapshot-1',integrationId:'integration-1',eventsSyncedAt:'2026-07-12T22:30:00Z' },
    '2026-07-12T22:30:00Z', 12,
    { async query(sql, params) {
      if (sql.includes('FROM eagle_outcome_imports')) return [[{ id:'import-1',sourceSystem:'crm',isComplete:1,recordsReceived:5,recordsWithWonAt:2 }]];
      if (sql.includes('FROM eagle_lead_events e') && sql.includes('GROUP BY DATE')) return [[{ date:'2026-07-10',appointments:2,wins:1 }]];
      if (sql.includes('COUNT(*) AS eligible')) {
        const previous = params.includes(60);
        return [[previous ? { eligible:8,appointed:2,won:1 } : { eligible:10,appointed:4,won:2 }]];
      }
      throw new Error(`Unexpected historical query: ${sql}`);
    } }
  );
  assert.equal(historicalWithWins.metrics.lead_to_win_rate.status, 'available');
  assert.equal(historicalWithWins.metrics.lead_to_win_rate.value, 20);
  assert.equal(historicalWithWins.metrics.appointment_to_win_rate.value, 50);
  assert.equal(historicalWithWins.trend[0].wins, 1);

  const schema = fs.readFileSync(path.join(__dirname,'..','sql','schema.sql'),'utf8');
  const routes = fs.readFileSync(path.join(__dirname,'..','src','routes','adminEagle.js'),'utf8');
  assert.ok(Number(SCHEMA_VERSION) >= 30, 'EAGLE event model requires schema revision 30 or newer');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS eagle_lead_events/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS eagle_outcome_imports/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS eagle_opportunity_snapshots/);
  assert.match(routes, /post\('\/api\/eagle\/opportunities\/import'/);
  console.log('EAGLE event model tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
