const assert=require('assert/strict');
const {REQUIRED_TABLES,freshnessCheck,summarizeControlHealth,telemetryWriterCheck,databaseClockCheck,verifyAuthenticationDatabase}=require('../src/services/sentinelHealth');

assert.ok(REQUIRED_TABLES.includes('sentinel_threat_cases'));
assert.ok(REQUIRED_TABLES.includes('sentinel_validation_observations'));
assert.ok(REQUIRED_TABLES.includes('sentinel_finding_dispositions'));
assert.ok(REQUIRED_TABLES.includes('sentinel_playbook_runs'));
assert.ok(REQUIRED_TABLES.includes('sentinel_playbook_reviews'));
assert.ok(REQUIRED_TABLES.includes('sentinel_playbook_simulations'));
assert.ok(REQUIRED_TABLES.includes('sentinel_playbook_validation_results'));
assert.ok(REQUIRED_TABLES.includes('sentinel_resource_items'));
assert.equal(freshnessCheck('api',new Date().toISOString(),4).status,'healthy');
assert.equal(freshnessCheck('api',new Date(Date.now()-20*60000).toISOString(),4).status,'degraded');
assert.equal(freshnessCheck('api',new Date(Date.now()-2*3600000).toISOString(),4).status,'critical');
assert.equal(summarizeControlHealth([{status:'healthy'},{status:'degraded'}]).status,'degraded');
assert.equal(summarizeControlHealth([{status:'degraded'},{status:'critical'}]).status,'critical');
assert.equal(telemetryWriterCheck({pending:0,failed:0,dropped:0,writers:{}}).status,'healthy');
assert.equal(telemetryWriterCheck({pending:0,failed:0,dropped:1,writers:{}}).status,'critical');
assert.equal(telemetryWriterCheck({pending:101,failed:0,dropped:0,writers:{}}).status,'degraded');
(async()=>{
  const nowMs=Date.UTC(2026,6,13,1,0,0);
  const healthy=await databaseClockCheck({query:async()=>[[{sessionOffsetMinutes:60,epochSeconds:nowMs/1000}]]},nowMs);
  assert.equal(healthy.status,'healthy');
  assert.equal(healthy.metrics.sessionOffsetMinutes,60);
  const critical=await databaseClockCheck({query:async()=>[[{sessionOffsetMinutes:60,epochSeconds:(nowMs-120000)/1000}]]},nowMs);
  assert.equal(critical.status,'critical');
  const authQueries=[
    [[{databaseName:'workbench'}]],
    [[{columnName:'id'},{columnName:'locationId'},{columnName:'username'},{columnName:'email'},{columnName:'passwordHash'},{columnName:'role'}]],
    [[{indexName:'idx_users_location_username'},{indexName:'idx_users_location_email'}]],
    [[{totalUsers:3,credentialUsers:3,bcryptUsers:1}]],
  ];
  const migration=await verifyAuthenticationDatabase({query:async()=>authQueries.shift()});
  assert.equal(migration.status,'degraded');
  assert.equal(migration.metrics.legacyHashUsers,2);
  assert.match(migration.detail,/replayable legacy hash path/);
  console.log('Sentinel control health tests passed');
})().catch((error)=>{console.error(error);process.exitCode=1;});
