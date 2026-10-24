const assert=require('assert/strict');
const { setPool }=require('../src/db/pool');
const { techniqueId,getValidationCoverage,evaluateValidationRun }=require('../src/services/sentinelValidation');

assert.equal(techniqueId('t1110.001'),'T1110.001');
assert.throws(()=>techniqueId('drop table'),(error)=>error.status===400);

async function run(){
  const pool={query:async(sql)=>{
    if(sql.includes('COUNT(*) AS observations'))return [[{observations:10,techniques:4,detected:6,missed:2,partial:1,prevented:1,avgDetectionSeconds:90}]];
    if(sql.includes('GROUP BY technique_id'))return [[{techniqueId:'T1110.001',tactic:'Credential Access',tests:4,detected:3,missed:1,lastTested:'2026-07-12T12:00:00Z'}]];
    if(sql.includes('mappedTechniques'))return [[{mappedTechniques:5,mappedRules:7}]];
    throw new Error('Unexpected validation query');
  }};
  setPool(pool);
  try{const coverage=await getValidationCoverage({sinceDays:90});assert.equal(coverage.totals.detectionRate,0.75);assert.equal(coverage.totals.mappedRules,7);assert.equal(coverage.techniques[0].missed,1);}
  finally{setPool(null);}

  const runRow={id:'run-1',name:'Auth validation',status:'running',detection_window_minutes:15};
  let outcome='pending';
  const correlationPool={query:async(sql)=>{
    if(sql.includes('FROM sentinel_validation_runs'))return [[runRow]];
    if(sql.includes('FROM sentinel_validation_observations'))return [[{id:'obs-1',run_id:'run-1',technique_id:'T1110.001',expected_rule_id:'login_fail_ip',outcome,simulated_at:'2026-07-12 12:00:00'}]];
    if(sql.includes('LEFT JOIN sentinel_rule_techniques'))return [[{id:'case-1',rule_id:'login_fail_ip',last_seen:'2026-07-12 12:02:00'}]];
    if(sql.startsWith('UPDATE sentinel_validation_observations')){outcome='detected';return [{affectedRows:1}];}
    throw new Error(`Unexpected correlation query: ${sql}`);
  }};
  setPool(correlationPool);
  try{const result=await evaluateValidationRun('run-1',{},'admin-1');assert.equal(result.detected,1);assert.equal(result.missed,0);assert.equal(result.run.observationRows[0].outcome,'detected');}
  finally{setPool(null);}
  console.log('Sentinel validation tests passed');
}
run().catch((error)=>{setPool(null);console.error(error);process.exitCode=1;});
