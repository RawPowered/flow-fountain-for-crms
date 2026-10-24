const assert=require('assert/strict');
const {CONFIRMATION,DEFAULT_POLICIES,retentionSpecs,executeRetention}=require('../src/services/sentinelRetention');

assert.equal(CONFIRMATION,'PURGE EXPIRED SENTINEL DATA');
assert.ok(DEFAULT_POLICIES.api_events>=30);
const specs=retentionSpecs(new Map());
assert.ok(specs.some((item)=>item.dataClass==='api_events'&&item.deleteSql==='DELETE FROM api_sentinel_events WHERE created_at<UTC_TIMESTAMP(3)-INTERVAL ? DAY LIMIT 10000'));
assert.ok(specs.some((item)=>item.dataClass==='validation_runs'&&item.afterDeleteSql));
assert.ok(specs.every((item)=>!item.deleteSql.includes('sentinel_threat_cases')));

executeRetention({confirmation:'wrong'},'root-1').then(
  ()=>{throw new Error('Invalid confirmation must fail');},
  (error)=>{assert.equal(error.code,'RETENTION_CONFIRMATION_REQUIRED');console.log('Sentinel retention safety tests passed');}
).catch((error)=>{console.error(error);process.exitCode=1;});
