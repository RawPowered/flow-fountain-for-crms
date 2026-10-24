const assert = require('assert/strict');
const { normalizeSubmission, getCampaignReport } = require('../src/services/campaignMonitor');

const normalized = normalizeSubmission({
  id: 'submission-1', contactId: 'contact-1', formId: 'form-1', createdAt: '2026-07-11T18:32:00Z',
  others: { eventData: {
    parentName: 'Chat Widget Form', type: 'page-visit', source: 'Social media', medium: 'form',
    referrer: 'https://social.example.invalid/post/123',
    page: {
      url: 'https://site.example.invalid/offer?utm_source=facebook&utm_campaign=summer&utm_content=post-a&fbclid=click-1',
      title: 'Example research landing page',
    },
  } },
}, { id: 'integration-1', location_id: 'location-1' }, 'run-1');

assert.equal(normalized[1], 'submission-1');
assert.equal(normalized[3], 'contact-1');
assert.equal(normalized[5], 'Chat Widget Form');
assert.equal(normalized[10], 'site.example.invalid');
assert.equal(normalized[13], 'social.example.invalid');
assert.equal(normalized[17], 'facebook');
assert.equal(normalized[19], 'summer');
assert.equal(normalized[20], 'post-a');
assert.equal(normalized[21], 'click-1');

(async () => {
  const statements = [];
  const report = await getCampaignReport({
    snapshotId:'snapshot-1',apiKeyId:'key-1',integrationId:'integration-1',days:'30',
  }, {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('FROM eagle_snapshots')) return [[{ integrationId:'integration-1',locationId:'location-1' }]];
      if (sql.includes('FROM eagle_campaign_sync_runs')) return [[]];
      if (sql.includes('AS submissions,COUNT(DISTINCT')) return [[{
        submissions:1,contacts:1,landingPages:1,forms:1,scheduledContacts:0,wonContacts:0,facebookSubmissions:1,
      }]];
      return [[]];
    },
  });
  assert.equal(report.summary.submissions, 1);
  for (const sql of statements.filter((statement) => statement.includes('eagle_campaign_events'))) {
    assert.ok(sql.indexOf(' FROM eagle_campaign_events') < (sql.indexOf(' GROUP BY') < 0 ? Infinity : sql.indexOf(' GROUP BY')));
  }
  console.log('Campaign Monitor tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
