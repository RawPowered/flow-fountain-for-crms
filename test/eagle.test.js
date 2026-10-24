const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  normalizeRecord, normalizeState, deriveDisposition, extractDemographics, resolveStoredDemographics, buildDemographicAnalytics,
  buildGeographicMetrics, listFacts,
  factFilters, buildPeriodMetadata,
} = require('../src/services/eagle');

assert.equal(normalizeState('Florida'), 'FL');
assert.equal(normalizeState('tx'), 'TX');
assert.equal(normalizeState('Not a state'), null);
assert.equal(deriveDisposition({}, ['dnc-blocked'], null), 'DNC');
assert.equal(deriveDisposition({ status: 'closed won' }, [], null), 'Closed Won');
assert.equal(deriveDisposition({ status: 'active' }, [], 'assigned'), 'Assigned');

const reportAsOf = new Date('2026-07-12T22:30:00Z');
const currentFilter = factFilters({ snapshotId: 'snapshot-1', days: '30', state: 'FL' }, '', { asOf: reportAsOf });
assert.match(currentFilter.where, /crm_date_added > DATE_SUB\(\?, INTERVAL \? DAY\)/);
assert.match(currentFilter.where, /crm_date_added <= \?/);
assert.equal(currentFilter.params[0], 'snapshot-1');
assert.equal(currentFilter.params[1], 'FL');
assert.equal(currentFilter.params[2], reportAsOf);
assert.equal(currentFilter.params[3], 30);
assert.equal(currentFilter.params[4], reportAsOf);

const previousFilter = factFilters({ snapshotId: 'snapshot-1', days: '30' }, '', { asOf: reportAsOf, periodShift: 1 });
assert.match(previousFilter.where, /crm_date_added <= DATE_SUB\(\?, INTERVAL \? DAY\)/);
assert.deepEqual(previousFilter.params, ['snapshot-1', reportAsOf, 60, reportAsOf, 30]);

const period = buildPeriodMetadata(reportAsOf, 30);
assert.equal(period.asOf, '2026-07-12T22:30:00.000Z');
assert.equal(period.periodStart, '2026-06-12T22:30:00.000Z');
assert.equal(period.previousPeriodStart, '2026-05-13T22:30:00.000Z');

const eagleHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'eagle.html'), 'utf8');
const eagleClient = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'eagle-dashboard.js'), 'utf8');
assert.match(eagleHtml, /Currently scheduled/);
assert.match(eagleHtml, /Actionable unassigned/);
assert.match(eagleHtml, /id="view-markets"/);
assert.match(eagleHtml, /id="view-leads"/);
assert.match(eagleHtml, /Revenue outcome evidence/);
assert.match(eagleHtml, /id="outcomeTrendChart"/);
assert.match(eagleHtml, /id="view-validation"/);
assert.match(eagleHtml, /id="demographicHeroHeadline"/);
assert.match(eagleHtml, /id="demographicComposition"/);
assert.match(eagleHtml, /class="eagle-side-nav"/);
assert.match(eagleHtml, /Executive Dashboard/);
assert.match(eagleHtml, /id="overviewAudience"/);
assert.match(eagleHtml, /data-kpi-drill="leads"/);
assert.match(eagleHtml, /data-kpi-disposition="Scheduled"/);
assert.match(eagleHtml, /Audience explorer/);
assert.match(eagleHtml, /demographicFieldSearch/);
assert.match(eagleHtml, /demographicContacts/);
assert.match(eagleClient, /demographics\/contacts/);
assert.match(eagleClient, /data-demographic-segment-field/);
assert.match(eagleClient, /EAGLE returned an empty response/);
assert.match(eagleClient, /mapFeatures=\[\]/);
assert.match(eagleHtml, /eagle-governed-only/);
assert.match(eagleClient, /renderRollout/);
assert.match(eagleClient, /renderDemographicSpotlights/);
assert.match(eagleClient, /renderDemographicReadiness/);
assert.match(eagleClient, /renderOverviewAudience/);
assert.match(eagleClient, /drillKpi/);
assert.match(eagleClient, /data-disposition-drill/);
assert.doesNotMatch(eagleHtml, /class="eagle-kpi[^"]*"[^>]*>\s*<span>Appointments<\/span>/);
assert.doesNotMatch(eagleClient, /curveMonotoneX/);
assert.match(eagleClient, /params\(\{ limit:50, offset:leadOffset \}, true\)/);
assert.match(eagleClient, /dashboard\?\.metrics/);
assert.match(eagleClient, /breakdown\?\.reconciliation/);
assert.doesNotMatch(eagleClient, /Number\(row\.scheduled\)\/Number\(row\.total\)/);
assert.match(eagleClient, /filter\(\(row\)=>!row\.isOther\)/);
assert.match(eagleClient, /renderHistoricalFunnel/);
assert.match(eagleClient, /Awaiting complete opportunity data/);

const record = {
  id: 'crm-1', locationId: 'location-1', firstName: 'Avery', lastName: 'Stone',
  email: 'avery@example.com', phone: '8135550100', city: 'Tampa', state: 'Florida',
  postalCode: '33602', source: 'Google Ads', campaign: 'Roof Replacement Q3',
  tags: ['Roof Repair', 'Appointment Booked', 'DNC-Clean'],
  dateAdded: '2026-07-10T12:00:00Z', dateUpdated: '2026-07-11T12:00:00Z',
};
const overlays = new Map([['crm-1', {
  lead_id: 'lead-1', serviceType: 'Other', status: 'assigned', assignedTo: 'user-1',
  username: 'Jordan', dncStatus: 'clean',
}]]);
const services = [{
  serviceType: 'Roofing', tagKeywords: ['roof'], isEnabled: true, isFallback: false, sortOrder: 10,
}, {
  serviceType: 'Other', tagKeywords: [], isEnabled: true, isFallback: true, sortOrder: 100,
}];
const fact = normalizeRecord(record, { id: 'integration-1', location_id: 'location-1' }, {
  idPath: 'id', serviceTypePath: 'serviceType', dateAddedPath: 'dateAdded', externalUpdatedPath: 'dateUpdated',
}, overlays, services);
assert.equal(fact.externalId, 'crm-1');
assert.equal(fact.fullName, 'Avery Stone');
assert.equal(fact.stateCode, 'FL');
assert.equal(fact.source, 'Google Ads');
assert.equal(fact.campaign, 'Roof Replacement Q3');
assert.equal(fact.serviceType, 'Roofing');
assert.equal(fact.disposition, 'Scheduled');
assert.equal(fact.dialAssignedTo, 'Jordan');
assert.equal(fact.dncStatus, 'clean');
assert.equal(fact.leadId, 'lead-1');
assert.equal(fact.demographics.firstName, 'Avery');
assert.equal(fact.demographics.city, 'Tampa');

const nestedAttributionFact = normalizeRecord({
  ...record, id:'crm-2', source:{ name:'Meta Paid Social' }, campaign:{ label:'Summer Growth' },
}, { id:'integration-1', location_id:'location-1' }, {
  idPath:'id', serviceTypePath:'serviceType', dateAddedPath:'dateAdded', externalUpdatedPath:'dateUpdated',
}, new Map(), services);
assert.equal(nestedAttributionFact.source,'Meta Paid Social');
assert.equal(nestedAttributionFact.campaign,'Summer Growth');
assert.notEqual(nestedAttributionFact.source,'[object Object]');

const demographicProfile = extractDemographics({
  firstName: 'Avery', dateOfBirth: '1986-04-12',
  customFields: [
    { id: 'books-id', value: 'Yes' },
    { id: 'children-id', value: '2' },
    { id: 'credit-id', value: '720' },
    { id: 'custom-id', value: 'Segment A' },
  ],
}, new Map([
  ['books-id', { field_name: 'Books', field_key: 'contact.books', data_type: 'TEXT' }],
  ['children-id', { field_name: 'Number of Children in Household', field_key: 'contact.number_of_children_in_household', data_type: 'NUMERICAL' }],
  ['credit-id', { field_name: 'Credit Score Median', field_key: 'contact.credit_score_median', data_type: 'NUMERICAL' }],
  ['custom-id', { field_name: 'Audience Segment', field_key: 'contact.audience_segment', data_type: 'SINGLE_OPTIONS' }],
]));
assert.equal(demographicProfile.books, 'Yes');
assert.equal(demographicProfile.numberChildrenHousehold, '2');
assert.equal(demographicProfile.creditScoreMedian, '720');
assert.equal(demographicProfile.customFields.audience_segment.value, 'Segment A');

const storedProfile = resolveStoredDemographics({
  customFields: { '04t7zctabf07yrcltahy': { label: 'fixture-field-12', value: 'Yes' } },
}, new Map([['04t7zctabf07yrcltahy', {
  field_id: 'fixture-field-12', field_key: 'contact.books', field_name: 'Books', data_type: 'TEXT',
}]]));
assert.equal(storedProfile.books, 'Yes');
assert.equal(storedProfile.customFields.books.label, 'Books');

const demographicAnalytics = buildDemographicAnalytics([
  demographicProfile,
  { books: 'No', numberChildrenHousehold: 0, creditScoreMedian: 680 },
]);
assert.equal(demographicAnalytics.summary.totalProfiles, 2);
assert.equal(demographicAnalytics.fields.find((item) => item.key === 'books').populated, 2);
assert.equal(demographicAnalytics.fields.find((item) => item.key === 'creditScoreMedian').numeric.median, 700);
assert.equal(demographicAnalytics.fields.find((item) => item.key === 'custom.audience_segment').topValues[0].label, 'Segment A');
assert.equal(demographicAnalytics.executive.profilesWithInsight, 2);
assert.equal(demographicAnalytics.executive.insightCoverage, 100);
assert.equal(demographicAnalytics.executive.spotlights.find((item) => item.key === 'creditScoreMedian').displayValue, 700);
assert.match(demographicAnalytics.executive.headline,/credit score/i);
assert.equal(demographicAnalytics.executive.contractVersion,'1.0');
assert.ok(demographicAnalytics.executive.composition.every((item)=>item.kind==='category'));

(async () => {
  const geographyPool = {
    async query(sql) {
      if (sql.includes('MAX(fetched_at)')) return [[{
        datasetYear: 2024, fetchedAt: '2025-12-01T00:00:00Z', states: 51, places: 32000,
      }]];
      if (sql.includes('FROM census_geography_reference')) return [[
        { geography_type: 'nation', state_code: null, place_fips: '', name: 'United States', normalized_name: 'united states', population: 340000000 },
        { geography_type: 'state', state_code: 'FL', place_fips: '', name: 'Florida', normalized_name: 'florida', population: 23000000 },
        { geography_type: 'place', state_code: 'FL', place_fips: '71000', name: 'Tampa', normalized_name: 'tampa', population: 400000 },
      ]];
      throw new Error(`Unexpected geography query: ${sql}`);
    },
  };
  const geography = await buildGeographicMetrics(
    geographyPool,
    { total: 76, geoCoverage: 100 },
    [{ label: 'FL', total: 76 }],
    [{ city: 'Tampa', state: 'FL', total: 70 }, { city: 'Unmatched Postal City', state: 'FL', total: 6 }]
  );
  assert.equal(geography.statesPresent, 1);
  assert.equal(geography.statePresencePercent, 2);
  assert.equal(geography.reportedCities, 2);
  assert.equal(geography.matchedCensusPlaces, 1);
  assert.equal(geography.placeMatchRate, 92.1);
  assert.equal(geography.leadsPer100k, 17.5);
  assert.equal(geography.cities[0].population, 400000);
  assert.equal(geography.cities[1].censusMatched, false);

  const facts = await listFacts({ snapshotId: 'snapshot-1' }, {
    async query(sql) {
      if (sql.includes('FROM eagle_snapshots')) return [[{
        id: 'snapshot-1', integrationId: 'integration-1', apiKeyId: 'key-1',
        locationId: 'location-1', status: 'completed',
      }]];
      if (sql.includes('SELECT external_contact_id AS contactId')) return [[{
        contactId: 'contact-1', name: 'Avery Stone', demographics: '{}',
      }]];
      if (sql.includes('SELECT COUNT(*) AS total FROM eagle_lead_facts')) return [[{ total: 1 }]];
      throw new Error(`Unexpected facts query: ${sql}`);
    },
  });
  assert.equal(
    facts.rows[0].crmUrl,
    'https://crm.example.invalid/v2/location/location-1/contacts/detail/contact-1'
  );
  console.log('EAGLE tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
