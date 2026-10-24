const assert = require('assert/strict');
const { computePosture } = require('../src/services/sentinelThreats');

function baseline(overrides = {}) {
  return computePosture({
    apiSummary:{ totals:{ errorRate:0,unauthorizedRate:0 } },
    loginSummary:{ totals:{ failRate:0 } },
    threats:{ counts:{ critical:0,high:0,medium:0,low:0 } },
    openCases:{ openCritical:0,openReview:0 },
    newAuthFailIps:0,
    operations:{ closureQualityRate:1 },
    freshness:{ apiLastSeen:new Date().toISOString() },
    ...overrides,
  });
}

const healthy = baseline();
assert.equal(healthy.score,100);

const operationalRisk = baseline({
  operations:{ slaBreached:2,unassigned:4,closureQualityRate:0.5 },
});
assert.ok(operationalRisk.score < healthy.score);
assert.ok(operationalRisk.factors.some((factor)=>factor.code==='sla_breaches'));
assert.ok(operationalRisk.factors.some((factor)=>factor.code==='unassigned_cases'));
assert.ok(operationalRisk.factors.some((factor)=>factor.code==='closure_quality'));

const stale = baseline({ freshness:{ apiLastSeen:new Date(Date.now()-60*60*1000).toISOString() } });
assert.ok(stale.factors.some((factor)=>factor.code==='telemetry_freshness'));

console.log('Sentinel posture tests passed');
