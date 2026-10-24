const assert = require('assert/strict');
const { setPool } = require('../src/db/pool');
const { transitionCaseLifecycle, appendCaseNote, getCaseOperationsReport } = require('../src/services/sentinelCases');

async function run() {
  const writes = [];
  const row = {
    id:'case-1', fingerprint:'rule:ip:1.2.3.4', rule_id:'rule', severity:'high',
    title:'Test case', summary:'Test', entity_type:'ip', entity:'1.2.3.4', status:'investigating',
    priority:'normal', count:3, reopen_count:0,
  };
  const pool = {
    query: async (sql, params = []) => {
      if (sql.startsWith('SELECT * FROM sentinel_threat_cases')) return [[{ ...row }]];
      if (sql.startsWith('SELECT id,case_id,admin_id,note_type')) return [[]];
      if (sql.includes('SUM(status IN')) return [[{
        total:8,newCases:2,unassigned:1,slaBreached:1,dueSoon:1,awaitingValidation:1,
        monitoring:1,reopened:1,resolvedInWindow:2,closedInWindow:1,qualityClosures:3,
        allClosures:4,avgTriageSeconds:600,avgResolutionSeconds:3600,oldestOpenSeconds:7200,
      }]];
      if (sql.startsWith('SELECT status,COUNT(*)')) return [[{ status:'open',total:2 },{ status:'closed',total:4 }]];
      if (sql.startsWith('SELECT severity,COUNT(*)')) return [[{ severity:'high',total:2 }]];
      if (sql.includes('AS analyst')) return [[{ analyst:'admin-1',casesHandled:3,resolved:2,closed:1,avgResolutionSeconds:3600 }]];
      writes.push({ sql, params });
      if (sql.startsWith('UPDATE sentinel_threat_cases SET status=')) {
        row.status = params[0]; row.owner_admin_id = params[1]; row.priority = params[2];
        row.confidence = params[3]; row.disposition = params[4];
        if (params[6]) row.resolution_summary = params[6];
        if (params[7]) row.validation_summary = params[7];
      }
      return [{ affectedRows:1 }];
    },
  };
  setPool(pool);
  try {
    await assert.rejects(
      transitionCaseLifecycle('case-1', { status:'resolved' }, 'admin-1'),
      (error) => error.code === 'CASE_RESOLUTION_REQUIRED'
    );
    assert.equal(writes.length, 0);

    const resolved = await transitionCaseLifecycle('case-1', {
      status:'resolved', disposition:'confirmed_malicious', confidence:'confirmed',
      resolutionSummary:'Malicious source blocked and affected credentials rotated.',
      note:'Validated the source against correlated authentication failures.',
    }, 'admin-1');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.disposition, 'confirmed_malicious');
    assert.ok(writes.some((entry) => entry.sql.includes('sentinel_case_status_history')));
    assert.ok(writes.some((entry) => entry.sql.includes('sentinel_case_notes')));

    await assert.rejects(
      transitionCaseLifecycle('case-1', {
        status:'closed', disposition:'confirmed_malicious', resolutionSummary:'Contained.',
      }, 'admin-1'),
      (error) => error.code === 'CASE_VALIDATION_REQUIRED'
    );

    await appendCaseNote('case-1', 'Shift handoff note.', 'admin-2');
    assert.ok(writes.filter((entry) => entry.sql.includes('INSERT INTO sentinel_case_notes')).length >= 2);
    const report = await getCaseOperationsReport({ sinceHours:24 });
    assert.equal(report.totals.slaBreached,1);
    assert.equal(report.totals.closureQualityRate,0.75);
    assert.equal(report.analysts[0].resolved,2);
  } finally {
    setPool(null);
  }
  console.log('Sentinel case lifecycle tests passed');
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
