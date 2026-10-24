const assert=require('assert/strict');
const {REVIEW_STATES,ITEM_TYPES,SEED_RESOURCES,mapResource}=require('../src/services/sentinelResources');
assert.ok(REVIEW_STATES.has('unreviewed'));assert.ok(REVIEW_STATES.has('actioned'));assert.ok(ITEM_TYPES.has('intelligence'));assert.ok(ITEM_TYPES.has('internal'));
assert.deepEqual(SEED_RESOURCES, []);
const mapped=mapResource({id:'r1',slug:'test',item_type:'reference',category:'framework',title:'Test',publisher:'NIST',priority:'normal',review_status:'monitoring',tags_json:'["risk"]',cves_json:'[]',techniques_json:'["T1078"]',is_pinned:1});
assert.deepEqual(mapped.tags,['risk']);assert.deepEqual(mapped.techniques,['T1078']);assert.equal(mapped.isPinned,true);
console.log('Sentinel resource center tests passed');
