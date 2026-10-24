const assert=require('assert/strict');
const {setPool}=require('../src/db/pool');
const {dailyRoutineKey,runDailyProtectionRoutine,mapRun}=require('../src/services/sentinelRoutines');

assert.equal(dailyRoutineKey(new Date('2026-07-12T23:59:00Z')),'daily_protection:2026-07-12');
assert.deepEqual(mapRun({id:'r1',routine_key:'daily_protection:2026-07-12',routine_type:'daily_protection',status:'completed',summary_json:'{"exceptions":[]}'}).summary,{exceptions:[]});

async function run(){
  let writes=0;
  setPool({query:async(sql)=>{
    if(sql.startsWith('SELECT * FROM sentinel_routine_runs'))return [[{id:'run-1',routine_key:dailyRoutineKey(),routine_type:'daily_protection',status:'completed',summary_json:'{"detections":{"findings":2}}',started_at:'2026-07-12 12:00:00',completed_at:'2026-07-12 12:01:00'}]];
    writes+=1;throw new Error('Idempotent routine must not write');
  }});
  try{const result=await runDailyProtectionRoutine({},'admin-1');assert.equal(result.reused,true);assert.equal(result.run.summary.detections.findings,2);assert.equal(writes,0);}
  finally{setPool(null);}
  console.log('Sentinel routine tests passed');
}
run().catch((error)=>{setPool(null);console.error(error);process.exitCode=1;});
