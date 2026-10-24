const assert = require('assert/strict');
const { formatDailySocMarkdown } = require('../src/services/sentinelReports');

const report = {
  generatedAt:'2026-07-12T18:00:00.000Z',windowHours:24,
  posture:{ score:82,grade:'watch',factors:[{ detail:'1 case SLA breach',impact:-4 }] },
  telemetry:{ apiRequests:120,apiErrors:4,unauthorized:2,loginEvents:20,loginFailures:3 },
  caseFlow:{ opened:3,triaged:2,contained:1,resolved:1,closed:1,reopened:0 },
  operations:{ totals:{ slaBreached:1,dueSoon:1,unassigned:1 } },
  containment:{ created:1,revoked:0,active:4 },
  priorityCases:[{ severity:'high',title:'Authentication burst',status:'investigating',ownerAdminId:null,entityType:'ip',entity:'1.2.3.4' }],
};

const markdown = formatDailySocMarkdown(report);
assert.match(markdown,/Sentinel Daily SOC Report/);
assert.match(markdown,/1 breached/);
assert.match(markdown,/UNASSIGNED/);
assert.match(markdown,/Secrets and raw forensic payloads are excluded/);
assert.doesNotMatch(markdown,/password|authorization|cookie|api[_ -]?key/i);

console.log('Sentinel daily report tests passed');
