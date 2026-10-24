const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const {evaluateCheck,summarizeChecks,countConsecutivePasses}=require('../src/services/eagleValidation');
const {SCHEMA_VERSION}=require('../src/config');

const metrics={
  current_won_rate:{label:'Currently won rate',unit:'percent',status:'available',value:12.4},
  new_leads:{label:'New leads',unit:'count',status:'available',value:100},
  lead_to_win_rate:{label:'Lead-to-win',unit:'percent',status:'unavailable',value:null},
};
const percentPass=evaluateCheck({metricId:'current_won_rate',referenceValue:12,evidenceReference:'crm-report-7'},0,metrics);
assert.equal(percentPass.outcome,'passed');
assert.equal(percentPass.toleranceType,'absolute');
assert.equal(percentPass.absoluteDifference,.4);
const countFail=evaluateCheck({metricId:'new_leads',referenceValue:97,toleranceValue:1,evidenceReference:'finance-export-4'},0,metrics);
assert.equal(countFail.outcome,'failed');
assert.equal(countFail.toleranceType,'percent_difference');
const unavailable=evaluateCheck({metricId:'lead_to_win_rate',referenceValue:5,evidenceReference:'opportunity-export-3'},0,metrics);
assert.equal(unavailable.outcome,'unavailable');
assert.deepEqual(summarizeChecks([percentPass,countFail,unavailable]),{total:3,passed:1,failed:1,unavailable:1});
assert.equal(countConsecutivePasses([{status:'passed',snapshotId:'s3'},{status:'passed',snapshotId:'s3'},{status:'passed',snapshotId:'s2'},{status:'failed',snapshotId:'s1'}]),2);
assert.equal(countConsecutivePasses([{status:'incomplete',snapshotId:'s3'},{status:'passed',snapshotId:'s2'}]),0);

const schema=fs.readFileSync(path.join(__dirname,'..','sql','schema.sql'),'utf8');
const routes=fs.readFileSync(path.join(__dirname,'..','src','routes','adminEagle.js'),'utf8');
const service=fs.readFileSync(path.join(__dirname,'..','src','services','eagleValidation.js'),'utf8');
assert.ok(Number(SCHEMA_VERSION)>=30,'EAGLE validation requires schema revision 30 or newer');
for(const table of ['eagle_validation_runs','eagle_validation_checks','eagle_rollout_states','eagle_rollout_audit']) assert.match(schema,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
assert.match(routes,/post\('\/api\/eagle\/validation-runs'/);
assert.match(routes,/put\('\/api\/eagle\/rollout'/);
assert.match(service,/SELECT api_key_id AS stateApiKeyId,rollout_mode AS mode/);
assert.match(service,/SET api_key_id=\?,rollout_mode=\?,promoted_by=\?/);
assert.match(service,/ownershipMatches:state\.stateApiKeyId === apiKeyId/);
assert.match(service,/API key ownership transfer:/);
console.log('EAGLE validation and rollout tests passed');
