const assert=require('assert/strict');
const {VALIDATION_GATES,OUTCOMES,summarizeValidation}=require('../src/services/sentinelPlaybookValidation');
assert.equal(VALIDATION_GATES.length,8);assert.ok(OUTCOMES.has('passed'));assert.ok(OUTCOMES.has('failed'));
const empty=summarizeValidation([]);assert.equal(empty.ready,false);assert.equal(empty.notTested,8);
const passed=summarizeValidation(VALIDATION_GATES.map((gate)=>({gate_key:gate.key,outcome:'passed',evidence_reference:`case:${gate.key}`,tested_by:'purple-1',tested_at:'2026-07-12'})));
assert.equal(passed.ready,true);assert.equal(passed.passed,8);assert.equal(passed.notTested,0);
const failed=summarizeValidation([{gate_key:'rollback',outcome:'failed'}]);assert.equal(failed.ready,false);assert.equal(failed.failed,1);
assert.ok(VALIDATION_GATES.some((gate)=>gate.key==='drift_reactivation'));
console.log('Sentinel playbook validation-gate tests passed');
