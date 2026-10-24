const assert=require('assert/strict');
const {REQUIRED_SCHEMA,REQUIRED_INDEXES,runSentinelPreflight,summarizePreflight}=require('../src/services/sentinelPreflight');
assert.equal(summarizePreflight([{status:'pass'},{status:'warn'}]).ready,true);
assert.equal(summarizePreflight([{status:'pass'},{status:'fail'}]).ready,false);
async function run(){
  const columns=Object.entries(REQUIRED_SCHEMA).flatMap(([table,names])=>names.map((column)=>({tableName:table,columnName:column})));
  const indexes=Object.entries(REQUIRED_INDEXES).flatMap(([table,names])=>names.map((index)=>({tableName:table,indexName:index})));
  const pool={query:async(sql)=>{if(sql.includes('information_schema.COLUMNS'))return[columns];if(sql.includes('information_schema.STATISTICS'))return[indexes];if(sql.includes('FROM app_settings'))return[[{setting_key:'installed',setting_value:'true'},{setting_key:'schema_version',setting_value:'33'}]];if(sql.includes('COUNT(*) AS totalUsers'))return[[{totalUsers:2,credentialUsers:2}]];if(sql.includes("status IN ('under_review'"))return[[]];throw new Error(`Unexpected preflight query: ${sql}`);}};
  const result=await runSentinelPreflight(pool);assert.equal(result.ready,true);assert.equal(result.failed,0);assert.ok(result.passed>10);console.log('Sentinel preflight tests passed');
}
run().catch((error)=>{console.error(error);process.exitCode=1;});
