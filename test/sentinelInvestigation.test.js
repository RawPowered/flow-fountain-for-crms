const assert = require('assert/strict');
const { setPool } = require('../src/db/pool');
const { getTimeline, getInvestigationProfile } = require('../src/services/sentinelThreats');

async function run() {
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM api_login_events') && sql.includes('ORDER BY created_at DESC')) return [[
        { id:'login-1',created_at:'2026-07-12T12:03:00Z',event_type:'login',outcome:'failure',username:'agent',ip:'1.2.3.4',location_id:'loc-1' },
        { id:'login-2',created_at:'2026-07-12T12:00:00Z',event_type:'login',outcome:'success',username:'agent',ip:'1.2.3.4',location_id:'loc-1' },
      ]];
      if (sql.includes('FROM api_sentinel_events') && sql.includes('ORDER BY created_at DESC') && !sql.includes('GROUP BY')) return [[
        { id:'api-1',created_at:'2026-07-12T12:04:00Z',method:'POST',path:'/api/users/login',status_code:401,duration_ms:12,ip:'1.2.3.4',location_id:'loc-1',surface:'api' },
        { id:'api-2',created_at:'2026-07-12T12:02:00Z',method:'GET',path:'/api/leads',status_code:200,duration_ms:8,ip:'1.2.3.4',location_id:'loc-1',surface:'api' },
      ]];
      if (sql.includes('COUNT(*) AS requests')) return [[{ requests:4,errors:2,unauthorized:2,uniquePaths:2,uniqueIps:1,firstSeen:'2026-07-12T12:00:00Z',lastSeen:'2026-07-12T12:04:00Z',avgDurationMs:10 }]];
      if (sql.includes('COUNT(*) AS events')) return [[{ events:2,successes:1,failures:1,identities:1,firstSeen:'2026-07-12T12:00:00Z',lastSeen:'2026-07-12T12:03:00Z' }]];
      if (sql.includes('GROUP BY path,method')) return [[{ path:'/api/users/login',method:'POST',requests:2,errors:2,lastSeen:'2026-07-12T12:04:00Z' }]];
      if (sql.includes('GROUP BY status_code')) return [[{ statusCode:401,total:2 },{ statusCode:200,total:2 }]];
      if (sql.includes('FROM sentinel_threat_cases')) return [[{ id:'case-1',severity:'high',status:'investigating',title:'Auth burst',last_seen:'2026-07-12T12:04:00Z' }]];
      if (sql.includes('FROM sentinel_ip_blocks')) return [[{ id:'block-1',ip:'1.2.3.4',is_active:1 }]];
      throw new Error(`Unexpected investigation query: ${sql}`);
    },
  };
  setPool(pool);
  try {
    const timeline = await getTimeline({ sinceHours:24,limit:2,ip:'1.2.3.4' });
    assert.deepEqual(timeline.items.map((item)=>item.raw.id), ['api-1','login-1']);
    assert.ok(timeline.nextCursor);

    const inv = await getInvestigationProfile({ entityType:'ip',entity:'1.2.3.4',sinceHours:24,limit:10 });
    assert.equal(inv.profile.requests,4);
    assert.equal(inv.profile.loginFailures,1);
    assert.equal(inv.relatedCases[0].id,'case-1');
    assert.equal(inv.containment.blocks[0].id,'block-1');
  } finally {
    setPool(null);
  }
  console.log('Sentinel investigation tests passed');
}

run().catch((error) => { setPool(null); console.error(error); process.exitCode=1; });
