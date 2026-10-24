const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { SCHEMA_VERSION } = require('../src/config');
const {
  EAGLE_METRIC_VERSION, EAGLE_METRIC_DEFINITIONS, governAttributionRows,
  buildBreakdown, buildMetricContracts, buildPeriodMetadata, factFilters,
} = require('../src/services/eagle');
const { ensureEagleMetricDefinitions } = require('../src/db/migrate');
const { CALL_CENTER_METRIC_DEFINITIONS } = require('../src/services/eagleCallCenter');

assert.equal(EAGLE_METRIC_VERSION, '2.0');
assert.equal(new Set(EAGLE_METRIC_DEFINITIONS.map((item) => item.metricId)).size, EAGLE_METRIC_DEFINITIONS.length);
assert.ok(EAGLE_METRIC_DEFINITIONS.every((item) => item.definitionVersion === EAGLE_METRIC_VERSION));

const governed = governAttributionRows([
  { label:'FB Lead Ads', total:12, scheduled:3, won:1 },
  { label:'facebook', total:8, scheduled:1, won:0 },
  { label:'Campaign ID: 85126652', total:5, scheduled:0, won:0 },
  { label:'Unattributed', total:4, scheduled:0, won:0 },
], 'source', [
  { dimensionType:'source', rawValue:'FB Lead Ads', canonicalValue:'Facebook', mappingStatus:'active', channel:'Paid Social' },
  { dimensionType:'source', rawValue:'facebook', canonicalValue:'Facebook', mappingStatus:'active', channel:'Paid Social' },
]);
assert.equal(governed.find((row) => row.label === 'Facebook').total, 20);
assert.equal(governed.find((row) => row.label === 'Facebook').scheduled, 4);
assert.equal(governed.find((row) => row.unknownReason === 'identifier_only').total, 5);
assert.equal(governed.find((row) => row.unknownReason === 'placeholder').total, 4);

const manyRows = Array.from({ length:25 }, (_, index) => ({
  label:`Source ${index + 1}`, total:25-index, scheduled:index % 3, won:index % 2,
}));
manyRows.push({ label:'Unattributed', total:2, scheduled:0, won:0, unknownReason:'placeholder' });
const breakdownTotal = manyRows.reduce((sum, row) => sum + row.total, 0);
const breakdown = buildBreakdown(manyRows, breakdownTotal, { limit:20 });
assert.equal(breakdown.rows.length, 20);
assert.ok(breakdown.rows.some((row) => row.label === 'Unattributed'));
assert.ok(breakdown.rows.some((row) => row.label === 'Other (remaining)'));
assert.equal(breakdown.reconciliation.returnedTotal, breakdownTotal);
assert.equal(breakdown.reconciliation.unknownTotal, 2);
assert.equal(breakdown.reconciliation.reconciled, true);
assert.ok(breakdown.rows.every((row) => row.sample && Object.hasOwn(row, 'share')));

const period = buildPeriodMetadata('2026-07-12T22:30:00Z', 30);
const metrics = buildMetricContracts({
  total:66, scheduled:6, won:2, actionableUnassigned:40, attributedSource:48, attributedCampaign:18,
  dncBlocked:13, geocoded:66, currentScheduledRate:9.1, currentWonRate:3, sourceCoverage:72.7,
  campaignCoverage:27.3, dncRate:19.7, totalDelta:22.2, scheduledRateDelta:1.7, wonRateDelta:.8,
  previous:{ total:54, scheduled:4, won:1, actionableUnassigned:38, attributedSource:39, attributedCampaign:12,
    dncBlocked:10, currentScheduledRate:7.4, currentWonRate:1.9, sourceCoverage:72.2,
    campaignCoverage:22.2, dncRate:18.5, geoCoverage:98 },
}, { dataCompleteness:100 }, period);
assert.equal(metrics.current_scheduled_rate.numerator, 6);
assert.equal(metrics.current_scheduled_rate.denominator, 66);
assert.equal(metrics.current_scheduled_rate.comparison.kind, 'percentage_points');
assert.equal(metrics.source_coverage.definitionVersion, '2.0');
assert.equal(metrics.location_completeness.value, 100);

const canonicalFilter = factFilters({
  snapshotId:'snapshot-1', integrationId:'integration-1', source:'Facebook', days:30,
}, '', { asOf:new Date('2026-07-12T22:30:00Z') });
assert.match(canonicalFilter.where, /eagle_attribution_mappings/);
assert.deepEqual(canonicalFilter.params.slice(0,5), ['snapshot-1','Facebook','integration-1','source','Facebook']);
const unknownFilter = factFilters({ snapshotId:'snapshot-1', integrationId:'integration-1', source:'Unattributed' });
assert.match(unknownFilter.where, /mapping_status = 'ignored'/);
assert.deepEqual(unknownFilter.params, ['snapshot-1','integration-1','source']);
const identifierFilter = factFilters({ snapshotId:'snapshot-1', integrationId:'integration-1', source:'Unmapped identifier' });
assert.match(identifierFilter.where, /REGEXP/);
assert.deepEqual(identifierFilter.params, ['snapshot-1']);

const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
const eagleRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminEagle.js'), 'utf8');
assert.ok(Number(SCHEMA_VERSION) >= 30, 'EAGLE governance requires schema revision 30 or newer');
assert.match(schema, /CREATE TABLE IF NOT EXISTS eagle_metric_definitions/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS eagle_attribution_mappings/);
assert.match(eagleRoutes, /get\('\/api\/eagle\/attribution-mappings'/);
assert.match(eagleRoutes, /put\('\/api\/eagle\/attribution-mappings'/);

(async () => {
  const calls = [];
  await ensureEagleMetricDefinitions({ async query(sql, params) { calls.push({ sql, params }); return [[]]; } });
  assert.equal(calls.length, EAGLE_METRIC_DEFINITIONS.length + CALL_CENTER_METRIC_DEFINITIONS.length);
  assert.ok(calls.every((call) => call.sql.includes('ON DUPLICATE KEY UPDATE')));
  console.log('EAGLE governance tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
