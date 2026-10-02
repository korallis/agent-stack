import test from 'node:test';
import assert from 'node:assert/strict';
import { renderV3, commandItems } from '../console/src/v3/render.ts';

const at = Date.parse('2026-10-02T12:00:00Z');
const step = (id, label, state = 'done', minutes = 10) => ({ id, label, state, at: new Date(at - minutes * 60000).toISOString(), detail: `${label} recorded` });
function fixture() {
  const teams = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Ops'].map((name, i) => ({ id: `team-${i}`, name, description: 'Neutral demo project', status: ['ok', 'blocked', 'waiting', 'ok', 'unknown'][i], reason: i === 1 ? 'decision needed' : '', sentence: 'A recorded status sentence for the current milestone.', milestone: 'Reliable delivery', progress: i === 4 ? null : 43 + i * 10, eta: null, milestones: [step('m1', 'Foundation'), step('m2', 'Delivery', 'active', 5), step('m3', 'Release', 'waiting', 0)], agentIds: [`agent-${i}`], taskIds: [`task-${i}`], merges: [{ day: 'Oct 01', count: 2 }, { day: 'Oct 02', count: 4 }] }));
  const agents = teams.map((team, i) => ({ id: `agent-${i}`, teamId: team.id, name: `builder-${i}`, model: 'Example model', status: 'ok', activity: 'Reviewing a recorded change', taskId: `task-${i}`, context: 37, contextHistory: [15, 20, 30, 37], tail: 'Read src/example.ts\nTests passed\nChecking the result', tailAt: at, history: [step('h1', 'Review completed')] }));
  const tasks = teams.map((team, i) => ({ id: `task-${i}`, teamId: team.id, title: `Review delivery ${i}`, status: 'ok', agentId: `agent-${i}`, prId: `pr-${i}`, acceptance: 'A verified result is attached.', steps: [step('queued', 'Queued', 'done', 40), step('build', 'Build', 'done', 30), step('review', 'Review', 'active', 10)], createdAt: new Date(at - 40 * 60000).toISOString(), updatedAt: new Date(at - 10 * 60000).toISOString() }));
  const prs = teams.map((team, i) => ({ id: `pr-${i}`, teamId: team.id, title: `Reliable delivery ${i}`, url: `https://example.invalid/pull/${i + 1}`, number: i + 1, state: 'OPEN', additions: 42, deletions: 3, files: 2, checks: [step('ci', 'Unit tests')], reviews: [step('rv', 'Independent review')], verdict: i === 1 ? 'HOLD' : 'ACT', band: 'recorded', reason: i === 1 ? 'Missing rollback evidence.' : 'Two independent reviewers approved.', signals: [{ name: 'Scope', value: '0.92' }], at: new Date(at).toISOString() }));
  return { version: 1, at, source: 'neutral fixture', stale: false, sources: {}, headline: 'One decision needs you. Other teams are making progress.', teams, agents, tasks, prs,
    capacity: ['Claude', 'Codex', 'Kimi', 'Grok'].map((provider, i) => ({ id: `capacity-${i}`, provider, label: `${provider} demo`, used: 30 + i * 15, weekly: 40, resetAt: new Date(at + 3600000).toISOString(), credits: null, status: 'ok', reason: '', history: [{ at: at - 3600000, used: 20 }, { at, used: 30 + i * 15 }] })),
    decisions: [0, 1, 2, 3].map(i => ({ id: `decision-${i}`, teamId: 'team-1', question: `Decision question ${i}`, blocks: 'Blocks the next milestone', createdAt: new Date(at - 600000).toISOString() })),
    events: [{ id: 'event', at: new Date(at).toISOString(), teamId: 'team-0', text: 'A recorded fallback moved work to another model.', status: 'waiting', taskId: 'task-0' }],
  };
}
const state = (view = 'fleet', extra = {}) => ({ view, teamId: 'team-0', agentId: 'agent-0', taskId: 'task-0', prId: 'pr-0', selected: 0, scroll: 0, help: false, command: null, frame: 0, paused: false, note: null, ...extra });
const words = result => result.screen.lines().join('\n');

test('fleet follows approved four-layer hierarchy with five rings and at most three questions', () => {
  const r = renderV3(fixture(), 180, 50, state());
  const rows = r.screen.lines();
  for (const label of ['NEEDS YOU', 'PROJECTS', 'CAPACITY', 'JUST HAPPENED']) assert.ok(words(r).includes(label));
  assert.ok(rows.findIndex(l => l.includes('NEEDS YOU')) < rows.findIndex(l => l.includes('PROJECTS')));
  assert.ok(rows.findIndex(l => l.includes('PROJECTS')) < rows.findIndex(l => l.includes('CAPACITY')));
  assert.match(words(r), /[\u2801-\u28ff]/);
  assert.match(words(r), /[▀▄]/);
  assert.ok(!words(r).includes('Decision question 3'));
  assert.equal(r.hits.filter(hit => hit.kind === 'team').length, 5);
  assert.equal(r.hits.filter(hit => hit.kind === 'decision').length, 3);
  assert.deepEqual(r.screen.bg, [0, 0, 0]);
});

for (const [view, labels] of Object.entries({ team: ['MILESTONES', 'FEATURE JOURNEYS', 'AGENTS', 'MERGED PER DAY', 'RECENT'], agent: ['LIVE TERMINAL', 'CONTEXT', 'NOW', 'HISTORY'], task: ['JOURNEY', 'time spent', 'WHAT TO DO', 'DONE WHEN', 'HISTORY', 'LINKED PR'], pr: ['PULL REQUESTS', 'PIPELINE', 'JEV MERGE GATE', 'CHECKS', 'REVIEWS'], capacity: ['UTILIZATION', 'ACCOUNTS', 'FALLBACK', 'RESET'] })) {
  test(`${view} contains its approved panels and real linked click targets`, () => {
    const r = renderV3(fixture(), 180, 50, state(view));
    for (const label of labels) assert.ok(words(r).includes(label), `${view}: missing ${label}`);
    if (view === 'team') assert.ok(r.hits.some(h => h.kind === 'agent' && h.id === 'agent-0'));
    if (view === 'agent') assert.ok(r.hits.some(h => h.kind === 'task' && h.id === 'task-0'));
    if (view === 'task') assert.ok(r.hits.some(h => h.kind === 'pr' && h.id === 'pr-0'));
    if (view === 'pr') assert.match(words(r), /Two independent reviewers approved/);
  });
}

test('all six views fit 100x30 and 180x50 with bounded hits and no mutation', () => {
  const snapshot = fixture(), before = structuredClone(snapshot);
  for (const [w, h] of [[100, 30], [180, 50], [160, 50]]) for (const view of ['fleet', 'team', 'agent', 'task', 'pr', 'capacity']) {
    const r = renderV3(snapshot, w, h, state(view));
    assert.equal(r.screen.lines().length, h);
    assert.ok(r.screen.lines().every(line => [...line].length === w));
    for (const hit of r.hits) assert.ok(hit.x >= 0 && hit.y >= 0 && hit.w > 0 && hit.h > 0 && hit.x + hit.w <= w && hit.y + hit.h <= h, JSON.stringify(hit));
  }
  assert.deepEqual(snapshot, before);
});

test('missing data is unknown, with no invented milestone progress, gate or burn', () => {
  const snapshot = fixture();
  snapshot.teams[0].progress = null; snapshot.teams[0].eta = null; snapshot.teams[0].milestones = []; snapshot.teams[0].merges = null;
  snapshot.agents[0].context = null; snapshot.agents[0].contextHistory = []; snapshot.agents[0].tail = null;
  snapshot.tasks[0].steps = []; snapshot.tasks[0].acceptance = null;
  snapshot.prs[0].verdict = 'UNKNOWN'; snapshot.prs[0].signals = []; snapshot.prs[0].reason = null;
  snapshot.capacity = [];
  for (const view of ['fleet', 'team', 'agent', 'task', 'pr', 'capacity']) assert.match(words(renderV3(snapshot, 180, 50, state(view))), /unknown|unavailable|not recorded/i);
  assert.doesNotMatch(words(renderV3(snapshot, 180, 50, state('pr'))), /Safe to merge/);
  assert.doesNotMatch(words(renderV3(snapshot, 180, 50, state('capacity'))), /tokens per minute/i);
});

test('empty snapshots and too-small windows remain usable without exceptions', () => {
  const snapshot = { ...fixture(), teams: [], agents: [], tasks: [], prs: [], decisions: [], events: [], capacity: [] };
  for (const view of ['fleet', 'team', 'agent', 'task', 'pr', 'capacity']) {
    assert.match(words(renderV3(snapshot, 100, 30, state(view))), /no .*|unknown|unavailable/i);
    const small = renderV3(snapshot, 40, 10, state(view));
    assert.match(words(small), /100.*30|resize/i);
  }
});

test('renderer removes terminal escapes, bidi controls and wide glyphs from untrusted content', () => {
  const snapshot = fixture();
  const unsafe = '\x1b]52;c;Y2xpcGJvYXJk\x07BAD\x1b[31m\u202e😀漢\u0000';
  snapshot.headline = unsafe; snapshot.agents[0].tail = unsafe; snapshot.tasks[0].title = unsafe;
  for (const view of ['fleet', 'agent', 'task']) {
    const text = words(renderV3(snapshot, 100, 30, state(view)));
    assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f\u202e]|😀|漢|Y2xpcGJvYXJk/);
    assert.match(text, /BAD/);
  }
});

test('overlays replace click targets and command filtering matches visible results', () => {
  const snapshot = fixture();
  const help = renderV3(snapshot, 180, 50, state('fleet', { help: true }));
  assert.match(words(help), /Help/); assert.match(words(help), /read-only/i);
  assert.equal(help.hits.length, 0);
  const choices = commandItems(snapshot, 'agent builder-2');
  assert.equal(choices.length, 1); assert.equal(choices[0].id, 'agent-2');
  const command = renderV3(snapshot, 180, 50, state('fleet', { command: 'agent builder-2' }));
  assert.equal(command.hits.length, 1); assert.equal(command.hits[0].id, 'agent-2');
  assert.match(words(command), /builder-2/);
});

test('selected IDs take priority over stale indexes and unknown context is never zero', () => {
  const snapshot = fixture(); snapshot.agents[2].context = null;
  const r = renderV3(snapshot, 180, 50, state('agent', { agentId: 'agent-2', selected: 0 }));
  assert.ok(r.hits.some(h => h.id === 'task-2'));
  assert.match(words(r), /context unknown|unknown context|unknown/i);
  const pr = renderV3(snapshot, 180, 50, state('pr', { prId: 'pr-1', selected: 0 }));
  assert.match(words(pr), /Missing rollback evidence/);
});

test('fleet groups multiple accounts into one provider and ignores irrelevant source failures', () => {
  const snapshot=fixture();
  snapshot.capacity.unshift({...snapshot.capacity[0],id:'second-claude',label:'Claude second'});
  snapshot.sources={heavy:'unavailable',accounts:'unavailable: stale usage'};
  const text=words(renderV3(snapshot,160,50,state()));
  assert.equal(text.split('\n').filter(line=>/^  Claude\s/.test(line)).length,1);
  assert.ok(text.includes('Kimi'));
  assert.ok(text.includes('accounts: unavailable'));
  assert.ok(!text.includes('heavy: unavailable'));
});

test('missing explicit identity never silently selects another task, agent or PR', () => {
  for(const view of ['task','agent','pr']) {
    const result=renderV3(fixture(),160,50,state(view,{[view+'Id']:'missing-record'}));
    assert.match(words(result), /No .* available/);
    assert.ok(!result.hits.some(h=>h.kind==='task'||h.kind==='agent'));
  }
});

test('fleet follows arrow selection even when returning from an earlier team', () => {
  const r=renderV3(fixture(),160,50,state('fleet',{teamId:'team-0',selected:2}));
  const second=r.hits.find(h=>h.kind==='team'&&h.id==='team-2');
  assert.deepEqual(r.screen.cells[second.y*r.screen.w+second.x].fg,[125,168,239]);
});

test('only explicit active journeys or working agents animate', () => {
  const snapshot=fixture();
  const task0=words(renderV3(snapshot,160,50,state('task',{frame:0})));
  const task1=words(renderV3(snapshot,160,50,state('task',{frame:1})));
  assert.notEqual(task0,task1);
  snapshot.agents[0].status='waiting';snapshot.agents[0].activity='Idle';
  assert.equal(words(renderV3(snapshot,160,50,state('agent',{frame:0}))),words(renderV3(snapshot,160,50,state('agent',{frame:1}))));
});

test('zero pending decisions shows the last actual answer and its age', () => {
  const snapshot=fixture();snapshot.decisions=[];
  snapshot.lastDecision={question:'Retain archived examples?',answeredAt:new Date(at-25*60000).toISOString(),answer:'Keep for two years.'};
  const r=renderV3(snapshot,160,50,state());
  assert.match(words(r),/Last answered.*25m ago/);
  assert.match(words(r),/Retain archived examples/);
  assert.match(words(r),/Keep for two years/);
  assert.equal(r.hits.filter(h=>h.kind==='decision').length,0);
  snapshot.decisions=[fixture().decisions[0]];
  assert.ok(!words(renderV3(snapshot,160,50,state())).includes('Last answered'));
});

test('provider summary uses known same-window usage with coverage and weekly fallback', () => {
  const snapshot=fixture();
  snapshot.capacity=[
    {...snapshot.capacity[0],id:'a',used:20,weekly:70},
    {...snapshot.capacity[0],id:'b',used:60,weekly:80},
    {...snapshot.capacity[0],id:'c',used:null,weekly:90},
    {...snapshot.capacity[1],id:'d',used:null,weekly:80},
    {...snapshot.capacity[1],id:'e',used:null,weekly:100},
  ];
  const text=words(renderV3(snapshot,160,50,state()));
  assert.ok(text.includes('40% of 5-hour limit used on average'));assert.ok(text.includes('Observed 2 of 3 accounts'));
  assert.ok(text.includes('90% of weekly limit used on average'));assert.ok(text.includes('Observed 2 of 2 accounts'));
  assert.doesNotMatch(text,/57%/);
  assert.match(words(renderV3(snapshot,160,50,state('capacity'))),/weekly limit used/);
});

test('capacity displays observed credit amounts and cooldown separately from reset', () => {
  const snapshot=fixture();snapshot.capacity=[{...snapshot.capacity[1],label:'demo-account',used:null,weekly:100,credits:'$42 left',resetAt:null,cooldownUntil:new Date(at+60*60000).toISOString()}];
  const text=words(renderV3(snapshot,160,50,state()));
  assert.match(text,/\$42 left/);
  assert.match(text,/cooldown.*1h/);
  assert.doesNotMatch(text,/lasts ~|reset 1h/);
});

test('capacity keeps history windows distinct and labels its account columns', () => {
  const snapshot=fixture();snapshot.capacity[0].history=[{at:at-60000,used:20,window:'5h'},{at,used:90,window:'weekly'}];
  const text=words(renderV3(snapshot,160,50,state('capacity')));
  assert.match(text,/5H\s+WEEKLY/);
  assert.match(text,/Claude 5h\/weekly/);
});

test('project evidence labels and operations cards avoid invented milestone percentages', () => {
  const snapshot=fixture();snapshot.teams[0].progressLabel='16/56 features pass · origin/main';
  snapshot.teams[4].kind='operations';snapshot.teams[4].name='Operations';snapshot.teams[4].status='ok';
  const r=renderV3(snapshot,160,50,state());const card=r.hits.find(h=>h.kind==='team'&&h.id==='team-4');
  const text=r.screen.lines().slice(card.y,card.y+card.h).map(l=>l.slice(card.x,card.x+card.w)).join('\n');
  assert.ok(words(r).includes('16/56 features pass'));
  assert.ok(!text.includes('Milestone unknown'));assert.ok(!text.includes('ETA unknown'));
  assert.ok(words(renderV3(snapshot,160,50,state('team'))).includes('16/56 features pass · origin/main'));
});

test('page scrolling exposes final acceptance, failed check and review evidence at both sizes', async () => {
  const {key}=await import('../console/src/v3/controller.ts');
  const snapshot=fixture();
  snapshot.tasks[0].acceptance=Array.from({length:30},(_,i)=>i===29?'FINAL_ACCEPTANCE_SENTINEL':`Criterion ${i}`).join('\n');
  snapshot.prs[0].checks=Array.from({length:20},(_,i)=>({...step(`check-${i}`,`Check ${i}`),state:i===19?'blocked':'done',detail:i===19?'FAILED_CHECK_REASON_SENTINEL':'Passed'}));
  snapshot.prs[0].reviews=Array.from({length:20},(_,i)=>({...step(`review-${i}`,`Review ${i}`),detail:i===19?'FINAL_REVIEW_REASON_SENTINEL':'Reviewed'}));
  for(const [w,h] of [[160,50],[100,30]])for(const [view,sentinel] of [['task','FINAL_ACCEPTANCE_SENTINEL'],['pr','FAILED_CHECK_REASON_SENTINEL'],['pr','FINAL_REVIEW_REASON_SENTINEL']]) {
    const st=state(view);let found=false;
    for(let n=0;n<40;n++){found ||= words(renderV3(snapshot,w,h,st)).includes(sentinel);key(st,'\x1b[6~',snapshot);}
    assert.ok(found,`${view} ${sentinel} unreachable at ${w}x${h}`);
  }
});

test('quota text preserves over-limit readings while bars remain bounded', () => {
  const snapshot=fixture();snapshot.capacity=[{...snapshot.capacity[0],used:123,weekly:145}];
  const text=words(renderV3(snapshot,160,50,state('capacity')));
  assert.ok(text.includes('123%'));assert.ok(text.includes('145%'));
  assert.ok(words(renderV3(snapshot,160,50,state())).includes('123% of 5-hour limit used'));
});

test('null detail identities respect bound parents instead of showing unrelated work', () => {
  const snapshot=fixture();
  snapshot.agents[0].taskId=null;snapshot.tasks[0].prId=null;
  assert.match(words(renderV3(snapshot,160,50,state('agent',{agentId:null,teamId:'missing-team'}))),/No agents available/);
  assert.match(words(renderV3(snapshot,160,50,state('task',{taskId:null,agentId:'agent-0'}))),/No tasks available/);
  assert.match(words(renderV3(snapshot,160,50,state('pr',{prId:null,taskId:'task-0'}))),/No pull requests available/);
});

test('single-line detail keys expose every intermediate check at minimum size', async () => {
  const {key}=await import('../console/src/v3/controller.ts');
  const snapshot=fixture();const labels=Array.from({length:20},(_,i)=>`EVIDENCE_${String(i).padStart(2,'0')}`);
  snapshot.prs[0].checks=labels.map((label,i)=>({...step(`check-${i}`,label),detail:`Reason ${i}`}));
  const st=state('pr'),seen=new Set();
  for(let n=0;n<100;n++){
    const text=words(renderV3(snapshot,100,30,st));for(const label of labels)if(text.includes(label))seen.add(label);
    key(st,']',snapshot);
  }
  assert.deepEqual([...seen],labels);
  key(st,'[',snapshot);assert.equal(st.scroll,99);
});
test('an idle agent does not spin merely because its task title names an active verb',()=>{
 const s=fixture();s.agents[0].activity='idle · Reviewing the delivery';
 assert.equal(words(renderV3(s,160,50,state('agent',{frame:0}))),words(renderV3(s,160,50,state('agent',{frame:1}))));
});

test('capacity wording names providers and distinguishes observation from availability',()=>{
 const snapshot=fixture();snapshot.capacity=[
  {...snapshot.capacity[0],id:'one',provider:'claude',used:63,weekly:70,cooldownUntil:new Date(at+3600000).toISOString(),resetAt:null},
  {...snapshot.capacity[0],id:'two',provider:'claude',used:null,weekly:null,status:'waiting',resetAt:null},
  {...snapshot.capacity[1],provider:'codex',used:null,weekly:82,credits:'Using credits',resetAt:null},
  {...snapshot.capacity[2],provider:'xai',used:42},
  {...snapshot.capacity[3],provider:'kimi-ai',used:34},
 ];
 const text=words(renderV3(snapshot,160,50,state()));
 for(const name of ['Claude','Codex','Grok','Kimi'])assert.ok(text.includes(name));
 assert.ok(text.includes('63% of 5-hour limit used'));assert.ok(text.includes('Observed 1 of 2 accounts'));
 assert.ok(text.includes('82% of weekly limit used'));assert.ok(text.includes('Using credits'));assert.match(text,/cooldown ends in 1h/);
 assert.doesNotMatch(text,/1 of 2 accounts available|1 of 2 accounts ready|reset in 1h/);
 const detail=words(renderV3(snapshot,160,50,state('capacity')));assert.ok(detail.includes('Observed 1 of 2 accounts'));assert.ok(detail.includes('63% of 5-hour limit used'));
});

test('missing provider usage and reset evidence stays explicit in fleet and capacity views',()=>{
 const snapshot=fixture();snapshot.capacity=[{...snapshot.capacity[0],used:null,weekly:null,resetAt:null,cooldownUntil:null,credits:null,history:[]}];
 for(const view of ['fleet','capacity']){
  const text=words(renderV3(snapshot,160,50,state(view)));
  assert.ok(text.includes('Usage not reported'),view);assert.ok(text.includes('Observed 0 of 1 account'),view);
  assert.ok(text.includes('Reset time not reported'),view);
  assert.doesNotMatch(text,/(?:^|\s)0%|resets in|reset due|cooldown ends|cooldown end due/);
 }
});
