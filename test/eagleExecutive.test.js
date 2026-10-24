const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const {buildExecutiveBrief,buildTrustStatus,ageHours}=require('../src/services/eagleExecutive');

const period={asOf:'2026-07-12T22:30:00Z'};
const metrics={
  new_leads:{metricId:'new_leads',status:'available',value:66,comparison:{kind:'percent_change',value:22.2}},
  actionable_unassigned:{metricId:'actionable_unassigned',status:'available',value:40},
  source_coverage:{metricId:'source_coverage',status:'available',value:72.7,numerator:48,denominator:66},
  dnc_blocked:{metricId:'dnc_blocked',status:'available',value:13,denominator:66},
  current_scheduled_rate:{metricId:'current_scheduled_rate',status:'available',value:9.1,comparison:{kind:'percentage_points',value:1.7}},
  current_won_rate:{metricId:'current_won_rate',status:'available',value:3,comparison:{kind:'percentage_points',value:-.5}},
  lead_to_win_rate:{metricId:'lead_to_win_rate',status:'unavailable',statusReason:'Complete opportunity evidence is missing.'},
};
const snapshot={id:'s1',completedAt:'2026-07-12T22:30:00Z'};
const rollout={mode:'governed',readyForGoverned:true,latestRun:{id:'r1',status:'passed',createdAt:'2026-07-12T22:35:00Z'}};
const brief=buildExecutiveBrief({period,metrics},rollout,snapshot,new Date('2026-07-13T00:00:00Z'));
assert.equal(brief.contractVersion,'1.1');
assert.match(brief.headline,/66 leads/);
assert.equal(brief.decision.posture,'action');
assert.match(brief.decision.headline,/up 22\.2%/);
assert.match(brief.decision.headline,/40 leads are waiting for ownership/);
assert.equal(brief.decision.scorecards.length,4);
assert.equal(brief.decision.primaryAction.id,'ownership');
assert.equal(brief.attention[0].id,'ownership');
assert.match(brief.attention.find((item)=>item.id==='source-gap').detail,/18 leads/);
assert.equal(brief.momentum.find((item)=>item.metricId==='current_won_rate').direction,'down');
assert.match(brief.momentum.find((item)=>item.metricId==='new_leads').text,/22\.2 percent/);
assert.equal(brief.trust.overall,'ready');
assert.equal(brief.trust.snapshot.status,'current');
const targetBrief=buildExecutiveBrief({period,metrics},rollout,snapshot,new Date('2026-07-13T00:00:00Z'),[
  {metricId:'source_coverage',metricLabel:'Source attributed',unit:'percent',currentValue:72.7,targetLabel:'≥ 80%',gap:7.3,status:'off_target',direction:'at_least',businessOwner:'Growth Operations'},
]);
assert.equal(targetBrief.targets.offTarget,1);
assert.match(targetBrief.attention.find((item)=>item.id==='target-source_coverage').detail,/7\.3 percentage points/);

const stale=buildTrustStatus(snapshot,rollout,new Date('2026-07-15T00:00:00Z'));
assert.equal(stale.snapshot.status,'stale');
assert.equal(stale.overall,'review');
assert.equal(ageHours('2026-07-12T22:30:00Z',new Date('2026-07-13T00:00:00Z')),1.5);

const html=fs.readFileSync(path.join(__dirname,'..','public','admin','eagle.html'),'utf8');
const client=fs.readFileSync(path.join(__dirname,'..','public','js','eagle-dashboard.js'),'utf8');
const routes=fs.readFileSync(path.join(__dirname,'..','src','routes','adminEagle.js'),'utf8');
assert.match(html,/Executive command center/);
assert.match(html,/id="briefScorecards"/);
assert.match(html,/What is driving performance/);
assert.match(html,/id="rolloutAuditRows"/);
assert.match(client,/renderExecutiveBrief/);
assert.match(routes,/buildExecutiveBrief/);
assert.match(routes,/get\('\/api\/eagle\/rollout-audit'/);
console.log('EAGLE executive brief tests passed');
