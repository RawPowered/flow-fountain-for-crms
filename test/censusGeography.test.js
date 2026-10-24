const assert = require('assert/strict');
const { normalizePlaceName, censusPlaceLabel, censusReferenceStatus } = require('../src/services/censusGeography');

assert.equal(censusPlaceLabel('Tampa city, Florida'), 'Tampa');
assert.equal(normalizePlaceName('St. Petersburg city, Florida'), 'saint petersburg');
assert.equal(normalizePlaceName('St. Petersburg'), 'saint petersburg');
assert.equal(normalizePlaceName('Louisville/Jefferson County metro government (balance), Kentucky'), 'louisville');

(async () => {
  const status = await censusReferenceStatus({
    query: async () => [[{
      datasetYear: 2024, fetchedAt: '2026-07-11 12:00:00', states: 50, districts: 1, places: 32000,
    }]],
  });
  assert.equal(status.available, true);
  assert.equal(status.datasetYear, 2024);
  assert.equal(status.states, 50);
  assert.equal(status.source, 'U.S. Census Bureau 2024 ACS 5-year');
  console.log('Census geography tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
