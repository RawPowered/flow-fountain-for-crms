const assert=require('assert/strict');
const {ACTION_REGISTRY,normalizeContext,buildActionPlan,redactContext}=require('../src/services/sentinelPlaybookActions');
assert.equal(Object.keys(ACTION_REGISTRY).length,5);
for(const action of Object.values(ACTION_REGISTRY)){assert.equal(action.sideEffects,false);assert.ok(['observe','recommend'].includes(action.riskClass));assert.equal(action.permission,'sentinel:read');}
assert.deepEqual(normalizeContext({entityType:'ip',entityValue:'203.0.113.5',hours:9999}),{entityType:'ip',entityValue:'203.0.113.5',caseId:null,findingId:null,hours:720});
assert.equal(redactContext(normalizeContext({entityType:'api_key',entityValue:'key_1234567890'})).entityValue,'key_…7890');
const incomplete=buildActionPlan({},normalizeContext({}));assert.equal(incomplete.find((item)=>item.id==='summarize_telemetry').eligible,false);
const complete=buildActionPlan({},normalizeContext({entityType:'path',entityValue:'/api/test'}));assert.ok(complete.every((item)=>item.eligible));
assert.throws(()=>normalizeContext({entityType:'cookie',entityValue:'secret'}),/Unsupported/);
console.log('Sentinel playbook safe-action tests passed');
