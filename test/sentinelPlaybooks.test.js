const assert=require('assert/strict');
const {LIFECYCLE,RUN_STATES,CATALOG,TRANSITIONS,normalizeSteps}=require('../src/services/sentinelPlaybooks');
assert.deepEqual([...LIFECYCLE],['draft','peer_review','approved','active','deprecated','archived']);
assert.ok(RUN_STATES.has('running'));assert.ok(RUN_STATES.has('completed'));
assert.equal(CATALOG.length,6);
assert.ok(CATALOG.some((item)=>item[0]==='compliance-denial'));
for(const item of CATALOG){assert.ok(item[5].length>=5,`${item[0]} requires a useful checklist`);assert.ok(item[4].length,`${item[0]} requires ATT&CK mapping`);}
assert.ok(TRANSITIONS.draft.has('peer_review'));assert.ok(!TRANSITIONS.draft.has('active'));
assert.ok(TRANSITIONS.peer_review.has('approved'));assert.ok(!TRANSITIONS.archived.size);
assert.deepEqual(normalizeSteps(['Collect evidence','Record decision']).map((step)=>step.riskClass),['observe','observe']);
assert.throws(()=>normalizeSteps([{name:'Unsafe',riskClass:'sensitive'},'Review']),/observe and recommend/);
console.log('Sentinel playbook foundation tests passed');
