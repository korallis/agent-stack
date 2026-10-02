import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FleetAdapter, snapshotFromRaw } from '../console/src/v3/adapter.ts';
import { bindVerdict, progressFromExecution, prFromGithub } from '../console/src/v3/sources.ts';
import { qrowFromItem } from '../console/src/model.ts';
import { parseAccounts } from '../console/src/data.ts';
import { cardText } from '../console/src/v3/wording.ts';
import { wrap } from '../console/src/v3/draw.ts';
import { renderV3 } from '../console/src/v3/render.ts';
import { initialState } from '../console/src/v3/controller.ts';
const at = Date.parse('2026-10-02T12:00:00Z');
const row = (id, extra={}) => ({id,state:'pending',priority:'routine',source:'coord@alpha',destination:'builder@alpha',blockedOn:null,tags:[],created:new Date(at-1000).toISOString(),updated:new Date(at).toISOString(),summary:'Build a feature',...extra});
const raw = (extra={}) => ({at,host:{id:'test'},daemon:{ok:true},rigs:[{id:'rig-a',name:'alpha',lifecycle:'running',seats:[]}],queue:[],attention:[],gates:[],accounts:[],heavy:[],events:[],refreshMs:5000,sources:{daemon:'ok'},...extra});
test('only pending decisions addressed to the owner need the human',()=>{
 const rows=[row('yes',{destination:'owner@external',humanIntent:'decision'}),row('update',{destination:'owner@external',humanIntent:'update'}),row('other',{destination:'someone@external',humanIntent:'decision'}),row('done',{destination:'owner@external',humanIntent:'decision',state:'done'})];
 const s=snapshotFromRaw(raw({queue:rows,attention:rows}));
 assert.deepEqual(s.decisions.map(d=>d.id),['yes']); assert.equal(s.decisions[0].teamId,'rig-a');
 assert.equal(s.teams[0].progress,null);assert.equal(s.teams[0].eta,null);assert.equal(s.teams[0].milestone,null);
});
test('queue normalisation preserves decision intent and rich detail',()=>{
 const r=qrowFromItem({qitemId:'a',state:'pending',humanIntent:'decision',body:'Do this',humanDetail:'Choose a direction',targetRepo:'example/widget'});
 assert.equal(r.humanIntent,'decision');assert.equal(r.body,'Do this');assert.equal(r.targetRepo,'example/widget');
});
test('progress requires complete authored membership and accepted proof, never queue completion',()=>{
 const e={mission:'release-one',sources:{arrangement:{manifest:'/project/mission.yaml'}},q2_sequencing:[{slice_id:'A',dir:'01-a'},{slice_id:'B',dir:'02-b'}],readiness:{slices:[{id:'01-a',readiness:{configured:true,state:'ready'}},{id:'02-b',readiness:{configured:true,state:'not-ready'}}]}};
 assert.equal(progressFromExecution(e).progress,50);assert.equal(progressFromExecution(e).eta,null);
 e.readiness.slices.pop();assert.equal(progressFromExecution(e).progress,null);
});
test('Jev verdicts bind to explicit repository and PR and reject a stale head',()=>{
 const pr=prFromGithub({url:'https://github.com/example/widget/pull/7',number:7,title:'Feature',state:'OPEN',headRefOid:'abc',statusCheckRollup:[],reviews:[]});
 const unbound={ts:'2026-10-02T12:00:00Z',decision:'review.merge_gate',band:'act',result:{decision:'merge'}};
 assert.equal(bindVerdict(pr,[unbound],'abc').verdict,'UNKNOWN');
 const bound={...unbound,pr:{repo:'example/widget',number:7,head:'abc'}};
 assert.equal(bindVerdict(pr,[bound],'abc').verdict,'UNKNOWN','logs alone never replace the current-head commit status');
 assert.equal(bindVerdict(pr,[bound],'def').verdict,'UNKNOWN');
 assert.equal(bindVerdict({...pr,url:'https://github.com/other/widget/pull/7'},[bound],'abc').verdict,'UNKNOWN');
});
test('capacity preserves units, missing reset and credits semantics',()=>{
 const accounts=parseAccounts(JSON.stringify([{label:'One',provider:'claude',status:'active',short_window_used:.42,weekly_used:.7,on_credits:true,has_credits:true},{label:'Two',provider:'codex',status:'active',weekly_used:65}]));
 const s=snapshotFromRaw(raw({accounts}));assert.equal(s.capacity[0].used,42);assert.equal(s.capacity[1].weekly,65);assert.equal(s.capacity[1].used,null);assert.equal(s.capacity[0].resetAt,null);assert.match(s.capacity[0].credits,/credit/i);
});
test('failed daemon marks preserved data stale even when raw timestamp advanced',()=>{
 const s=snapshotFromRaw(raw({daemon:{ok:false,error:'offline'},queue:[row('a')]}));assert.equal(s.stale,true);assert.equal(s.tasks.length,1);assert.match(s.sources.daemon,/offline|stale|unavailable/);
});
test('startup hydrates a bounded cache immediately without awaiting network; stop suppresses late work',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v3-data-'));const file=path.join(dir,'snapshot.json');
 try {fs.writeFileSync(file,JSON.stringify(snapshotFromRaw(raw({queue:[row('cached')]}))));
 let cb;let started=false;let stopped=false;const cache={raw:raw({daemon:{ok:false}}),onChange(fn){cb=fn},start(){started=true},stop(){stopped=true},soon(){},setSeat(){},setView(){}};
 const a=new FleetAdapter({projectsRoot:null,url:'http://unused',interval:5000,cacheFile:file,cache});
 assert.equal(a.snapshot().tasks[0].id,'cached');assert.equal(a.snapshot().stale,true);
 let changes=0;a.start(()=>changes++);assert.equal(started,true);a.stop();cb();assert.equal(stopped,true);assert.equal(changes,0);
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
});

test('a late stale cache cannot replace a healthy empty fleet',()=>{
 let cb;const cache={raw:raw({rigs:[],queue:[]}),onChange(fn){cb=fn},start(){},stop(){},soon(){},setSeat(){},setView(){}};
 const a=new FleetAdapter({projectsRoot:null,url:'http://unused',interval:5000,cacheFile:null,cache,run:async()=>null});a.start(()=>{});cb();assert.deepEqual(a.snapshot().teams,[]);assert.equal(a.snapshot().stale,false);a.stop();
});
test('bounded HTTP reads reject oversized and never-ending bodies',async()=>{
 const { getJson }=await import('../console/src/v3/sources.ts');const http=await import('node:http');
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});if(req.url==='/large')res.end(JSON.stringify('x'.repeat(1000)));else res.write('{');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 try{await assert.rejects(getJson(url+'/large',AbortSignal.timeout(1000),50),/limit/);await assert.rejects(getJson(url+'/hang',AbortSignal.timeout(50)),/abort|timeout/i);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('live-shaped read-only daemon enriches selected task, decision and exact PR',async()=>{
 const http=await import('node:http');const requests=[];
 const item={qitemId:'q-1',state:'pending',sourceSession:'coord@alpha',destinationSession:'owner@external',humanIntent:'decision',tsCreated:new Date(at).toISOString(),tsUpdated:new Date(at).toISOString(),tags:['pr:7'],targetRepo:'example/widget',summary:'Choose rollout',body:'Please approve https://github.com/example/widget/pull/7',humanDetail:'Ship this release?'};
 const server=http.createServer((req,res)=>{requests.push(`${req.method} ${req.url}`);res.setHeader('content-type','application/json');let body={};if(req.url==='/healthz')body={status:'ok'};else if(req.url==='/api/rigs/summary')body=[{id:'rig-a',name:'alpha'}];else if(req.url==='/api/rigs/rig-a/nodes')body=[];else if(req.url.startsWith('/api/queue/list'))body=[{...item,summary:null,body:null,humanDetail:null}];else if(req.url.startsWith('/api/queue/recent-transitions'))body=[];else if(req.url==='/api/queue/q-1')body=item;else if(req.url==='/api/queue/q-1/transitions')body=[{transitionId:1,ts:new Date(at).toISOString(),state:'pending',actorSession:'coord@alpha',transitionNote:'Created'}];res.end(JSON.stringify(body));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const commands=[];const a=new FleetAdapter({projectsRoot:null,url:`http://127.0.0.1:${server.address().port}`,interval:60000,events:false,cacheFile:null,jevLog:'/nonexistent',run:async(cmd,args)=>{commands.push([cmd,args]);return cmd==='gh'&&args[1]==='view'?JSON.stringify({url:'https://github.com/example/widget/pull/7',number:7,title:'Feature',state:'OPEN',headRefOid:'abc',statusCheckRollup:[],reviews:[]}):'[]';}});
 try{const ready=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('enrichment timed out')),3000);a.start(()=>{const s=a.snapshot();if(s.prs.length&&s.tasks[0]?.body){clearTimeout(timeout);resolve();}});});a.select({taskId:'q-1'});await ready;
 const s=a.snapshot();assert.equal(s.decisions[0].question,'Ship this release?');assert.equal(s.tasks[0].prId,s.prs[0].id);assert.match(s.tasks[0].body,/Please approve/);assert.equal(s.prs[0].verdict,'UNKNOWN');assert.equal(s.tasks[0].steps[0].detail,'coord@alpha Created');assert.ok(requests.every(r=>r.startsWith('GET ')));assert.ok(requests.every(r=>!/capture|tail|refresh/.test(r)));assert.equal(commands.filter(([cmd,args])=>cmd==='gh'&&args[1]==='view').length,1);
 }finally{a.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('team status and headline explain human decisions and exact open PR holds',()=>{
 const s=snapshotFromRaw(raw({queue:[row('decision',{destination:'owner@external',humanIntent:'decision'})]}));assert.equal(s.teams[0].status,'blocked');assert.match(s.headline,/alpha/);assert.match(s.teams[0].reason,/decision/);
 const pr=prFromGithub({url:'https://github.com/example/widget/pull/7',number:7,state:'OPEN'},'rig-a');pr.verdict='HOLD';const held=snapshotFromRaw(raw(),{prs:[pr]});assert.equal(held.teams[0].status,'blocked');assert.match(held.teams[0].reason,/PR #7/);
});
test('active task outranks a newer pending row and supplies agent activity',()=>{
 const seat={rig:'alpha',pod:'impl',name:'builder',session:'builder@alpha',kind:'agent',activity:'working',model:null,ctx:null,why:null};
 const s=snapshotFromRaw(raw({rigs:[{id:'rig-a',name:'alpha',seats:[seat]}],queue:[row('active',{state:'in-progress',summary:'Implement checkout',updated:new Date(at-5000).toISOString()}),row('pending')]}));assert.equal(s.agents[0].taskId,'active');assert.match(s.agents[0].activity,/Implement checkout/);
});
test('account failures keep last readings but healthy empty clears them',async()=>{
 const {Cache}=await import('../console/src/data.ts');const http=await import('node:http');let now=at,text=JSON.stringify([{label:'Account',provider:'codex',status:'active',weekly_used:60}]);
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/healthz'?{status:'ok'}:[]));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const cache=new Cache({url:`http://127.0.0.1:${server.address().port}`,interval:60000,events:false,now:()=>now,run:async(cmd)=>cmd==='agent-proxy-status'?text:''});
 try{await cache.tick();assert.equal(cache.raw.accounts[0].weekly,60);now+=60000;text=null;await cache.tick();assert.equal(cache.raw.accounts[0].weekly,60);assert.match(cache.raw.sources.accounts,/unavailable/);now+=60000;text='[]';await cache.tick();assert.deepEqual(cache.raw.accounts,[]);assert.equal(cache.raw.sources.accounts,'ok');}finally{cache.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('PR identity alone cannot claim a current head verdict',()=>{
 const pr=prFromGithub({url:'https://github.com/example/widget/pull/7',number:7,state:'OPEN'});
 const r={ts:'2026-10-02T12:00:00Z',decision:'review.merge_gate',band:'act',result:{decision:'merge'},pr:{repo:'example/widget',number:7}};
 assert.equal(bindVerdict(pr,[r],'abc').verdict,'UNKNOWN');
});
test('done-when comes only from explicit acceptance text, never an evidence path',()=>{
 const s=snapshotFromRaw(raw({queue:[row('a',{evidenceRef:'/proof/report.md'}),row('b',{body:'## What to do\nBuild this.\n\n## Acceptance criteria\n- The customer can save.\n- A failed save remains visible.\n\n## Notes\nOther text.'})]}));
 assert.equal(s.tasks[0].acceptance,null);assert.match(s.tasks[1].acceptance,/customer can save/);assert.doesNotMatch(s.tasks[1].acceptance,/Other text/);
});
test('fleet enriches authored progress without selecting a team and labels capped merges',async()=>{
 const http=await import('node:http');const requests=[];
 const rows=[row('a',{state:'in-progress',tags:['project:demo','mission:release-one','pr:7'],targetRepo:'example/widget'}),row('b',{destination:'builder@beta',tags:['project:second','mission:release-two']}),row('c',{tags:['project:demo','mission:old-release']})];
 const server=http.createServer((req,res)=>{requests.push(req.url);res.setHeader('Content-Type','application/json');const u=new URL(req.url,'http://test');if(u.pathname==='/api/queue/list'){res.end('[]');return;}if(u.pathname==='/api/views/execution'){res.end(JSON.stringify({rows:[{project:u.searchParams.get('project'),mission:u.searchParams.get('mission'),sources:{arrangement:{manifest:'/project/mission.yaml'}},q2_sequencing:[{slice_id:'A',dir:'a'},{slice_id:'B',dir:'b'}],readiness:{slices:[{id:'A',readiness:{configured:true,state:'ready'}},{id:'B',readiness:{configured:true,state:'not-ready'}}]}}]}));}else{const r=rows.find(r=>u.pathname.endsWith('/'+r.id));res.end(JSON.stringify({qitemId:r.id,state:r.state,tags:r.tags,targetRepo:r.targetRepo,sourceSession:r.source,destinationSession:r.destination,tsCreated:r.created,tsUpdated:r.updated,summary:r.summary}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let cb;const cache={raw:raw({queue:rows,rigs:[{id:'rig-a',name:'alpha',seats:[]},{id:'rig-b',name:'beta',seats:[]}]}),onChange(fn){cb=fn},start(){cb()},stop(){},soon(){},setSeat(){},setView(){}};
 const a=new FleetAdapter({projectsRoot:null,url:`http://127.0.0.1:${server.address().port}`,interval:5000,cache,cacheFile:null,jevLog:'/nonexistent',run:async(cmd,args)=>args[1]==='view'?JSON.stringify({url:'https://github.com/example/widget/pull/7',number:7,state:'MERGED',headRefOid:'abc'}):JSON.stringify(Array.from({length:100},(_,i)=>({number:i+1,mergedAt:new Date(at).toISOString()})))});
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('background progress timed out')),2000);a.start(()=>{const s=a.snapshot();if(s.teams.every(t=>t.progress===50)&&s.teams[0].merges?.length){clearTimeout(timer);resolve();}});});const s=a.snapshot();assert.equal(s.teams[0].merges.at(-1).count,100);assert.match(s.sources['merges:rig-a'],/^Lower bounds/);assert.equal(requests.filter(r=>r.startsWith('/api/views/execution')).length,2);}finally{a.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('failed polls retain the last successful fleet observation time',()=>{
 let cb;const cache={raw:raw(),onChange(fn){cb=fn},start(){},stop(){},soon(){},setSeat(){},setView(){}};
 const a=new FleetAdapter({projectsRoot:null,url:'http://unused',interval:5000,cacheFile:null,cache,run:async()=>null});a.start(()=>{});cb();assert.equal(a.snapshot().at,at);cache.raw={...cache.raw,at:at+60000,daemon:{ok:false,error:'offline'}};cb();assert.equal(a.snapshot().at,at);assert.equal(a.snapshot().stale,true);a.stop();
});
test('owner address is injected, planned waits are amber, person blockers are red, and idle seats are fine',()=>{
 const seat={rig:'alpha',pod:'impl',name:'builder',session:'builder@alpha',kind:'agent',activity:'idle',model:null,ctx:null,why:null};
 const planned=row('wait',{state:'blocked',blockedOn:'qitem-upstream',waiting:{nextBackstop:{mechanism:'watchdog:future',dueAt:new Date(at+60000).toISOString()},liveness:{activity:'working'}}});
 let s=snapshotFromRaw(raw({rigs:[{id:'rig-a',name:'alpha',seats:[seat]}],queue:[planned]}));assert.equal(s.tasks[0].status,'waiting');assert.equal(s.teams[0].status,'waiting');assert.doesNotMatch(s.teams[0].reason,/blocked task/);
 s=snapshotFromRaw(raw({queue:[row('person',{state:'blocked',blockedOn:'human-review@external'})]}),{ownerAddress:'human-review@external'});assert.equal(s.teams[0].status,'blocked');
 s=snapshotFromRaw(raw({queue:[row('ask',{destination:'human-review@external',humanIntent:'decision'})]}),{ownerAddress:'human-review@external'});assert.equal(s.decisions.length,1);
 s=snapshotFromRaw(raw({rigs:[{id:'rig-a',name:'alpha',seats:[seat]}]}));assert.equal(s.agents[0].status,'ok');assert.equal(s.teams[0].status,'ok');
});
test('current PR head jev-merge status is a real gate even when decision logs lack identity',()=>{
 const p={url:'https://github.com/example/widget/pull/7',number:7,headRefOid:'abc',state:'OPEN',statusCheckRollup:[{context:'jev-merge',state:'SUCCESS',description:'merge: act',createdAt:'2026-10-02T12:00:00Z'}]};
 const pr=prFromGithub(p);assert.equal(pr.verdict,'ACT');assert.match(pr.reason,/head abc/);assert.equal(bindVerdict(pr,[{decision:'review.merge_gate',result:{decision:'hold'}}],'abc').verdict,'ACT');
 p.statusCheckRollup[0].state='FAILURE';assert.equal(prFromGithub(p).verdict,'HOLD');p.headRefOid=null;assert.equal(prFromGithub(p).verdict,'UNKNOWN');
});
test('operational teams retain their identity and do not turn routine parked rows into blocked projects',()=>{
 const s=snapshotFromRaw(raw({rigs:[{id:'ops',name:'kernel',seats:[]}],queue:[row('park',{destination:'operator@kernel',state:'blocked',waiting:{nextBackstop:{mechanism:'watchdog:later',dueAt:new Date(at+60000).toISOString()}}})]}));assert.equal(s.teams[0].kind,'operations');assert.equal(s.teams[0].name,'Operations');assert.notEqual(s.teams[0].status,'blocked');assert.ok(s.teams[0].description);
});
test('native agent declarations include only the matching live terminal seat and worktree',()=>{
 const seat=(session,cwd)=>({rig:'alpha',pod:'impl',name:session.split('@')[0],session,kind:'infrastructure',runtime:'te',activity:'idle',model:null,ctx:null,why:null,cwd});
 const scope={name:'Example',description:'A demo project',milestone:null,progress:null,eta:null,milestones:[],activeMissions:[],nativeAgents:{'native@alpha':{cwd:'/project/worktree',model:'grok-example'}}};
 const s=snapshotFromRaw(raw({rigs:[{id:'rig-a',name:'alpha',seats:[seat('native@alpha','/project/worktree'),seat('human@alpha','/project/worktree'),seat('other@alpha','/project/other')]}]}),{projects:{alpha:scope}});
 assert.deepEqual(s.agents.map(a=>a.id),['native@alpha']);assert.equal(s.agents[0].model,'grok-example');
 scope.nativeAgents['native@alpha'].cwd='/different';assert.deepEqual(snapshotFromRaw(raw({rigs:[{id:'rig-a',name:'alpha',seats:[seat('native@alpha','/project/worktree')]}]}),{projects:{alpha:scope}}).agents,[]);
});
test('last answered decision requires a done transition by the configured owner',async()=>{
 const http=await import('node:http');let ownerCalls=0,cb;const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url.startsWith('/api/queue/list?destinationSession='))res.end(JSON.stringify([{qitemId:'answered',state:'done',destinationSession:'human-review@external',humanIntent:'decision',summary:'Approve the direction?',tsUpdated:new Date(at).toISOString()}]));else res.end(JSON.stringify([{state:'done',actorSession:'human-review@external',ts:new Date(at).toISOString(),transitionNote:'direct human reply received'}]));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const cache={raw:raw(),onChange(fn){cb=fn},start(){cb()},stop(){},soon(){},setSeat(){},setView(){}};const a=new FleetAdapter({projectsRoot:null,cacheFile:null,cache,url:`http://127.0.0.1:${server.address().port}`,interval:60000,run:async cmd=>{if(cmd==='agent-owner-address'){ownerCalls++;return 'human-review@external';}return null;}});
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('answer read timed out')),2000);a.start(()=>{if(a.snapshot().lastDecision){clearTimeout(timer);resolve();}});});assert.equal(a.snapshot().lastDecision.question,'Approve the direction?');assert.equal(a.snapshot().lastDecision.answeredAt,new Date(at).toISOString());assert.equal(ownerCalls,1);}finally{a.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('a head-bound status does not borrow signals from a different or unidentified gate run',()=>{
 const pr=prFromGithub({url:'https://github.com/example/widget/pull/7',number:7,headRefOid:'abc',statusCheckRollup:[{context:'jev-merge',state:'SUCCESS',targetUrl:'https://github.com/example/widget/pull/7#issuecomment-1'}]});
 const log={ts:new Date(at).toISOString(),decision:'review.merge_gate',band:'hold',result:{decision:'hold'},pr:{repo:'example/widget',number:7,head:'abc'},signals:{confidence:.9}};
 const bound=bindVerdict(pr,[log],'abc','https://github.com/example/widget/pull/7#issuecomment-1');assert.equal(bound.verdict,'ACT');assert.equal(bound.band,null);assert.deepEqual(bound.signals,[]);
});
test('owner lookup cannot publish partial daemon health or consume the first wake enrichment',async()=>{
 const http=await import('node:http');let cb;const item={qitemId:'park',state:'blocked',sourceSession:'coord@alpha',destinationSession:'builder@alpha',tags:[],tsCreated:new Date(at).toISOString(),tsUpdated:new Date(at).toISOString(),waiting:{nextBackstop:{mechanism:'watchdog:later',dueAt:new Date(at+60000).toISOString()}}};
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.includes('state=blocked')?[item]:req.url==='/api/queue/park'?item:[]));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const cache={raw:raw({daemon:{ok:false},rigs:[]}),onChange(fn){cb=fn},start(){},stop(){},soon(){},setSeat(){},setView(){}};const a=new FleetAdapter({projectsRoot:null,cacheFile:null,cache,url:`http://127.0.0.1:${server.address().port}`,interval:60000,run:async cmd=>cmd==='agent-owner-address'?'owner@external':null});
 try{a.start(()=>{});cache.raw.daemon.ok=true;await new Promise(r=>setTimeout(r,10));assert.equal(a.snapshot().stale,true,'health changed internally but the cache has not completed a publication');cache.raw=raw({queue:[row('park',{state:'blocked'})]});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('first wake data not loaded')),2000);a.start(()=>{if(a.snapshot().sources.waiting==='live wake records'){clearTimeout(timer);resolve();}});cb();});assert.equal(a.snapshot().tasks[0].status,'waiting');}finally{a.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('PR refresh failures retain historical gates per PR and cannot be erased by another success',async()=>{
 const http=await import('node:http');const {renderV3}=await import('../console/src/v3/render.ts');const {initialState,open}=await import('../console/src/v3/controller.ts');
 const rows=[1,2].map(n=>row('pr-'+n,{state:'in-progress',tags:['pr:'+n],targetRepo:'example/widget'}));
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');const r=rows.find(r=>req.url==='/api/queue/'+r.id);res.end(JSON.stringify(r?{qitemId:r.id,state:r.state,tags:r.tags,targetRepo:r.targetRepo,sourceSession:r.source,destinationSession:r.destination,tsCreated:r.created,tsUpdated:r.updated}:[]));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let cb,mode='healthy',reads=0;
 const cache={raw:raw({queue:rows}),onChange(fn){cb=fn},start(){cb()},stop(){},soon(){},setSeat(){},setView(){}};
 const adapter=new FleetAdapter({projectsRoot:null,ownerAddress:'owner@external',cacheFile:null,cache,url:`http://127.0.0.1:${server.address().port}`,interval:60000,jevLog:'/nonexistent',now:()=>cache.raw.at,run:async(cmd,args)=>{
  if(cmd!=='gh'||args[1]!=='view')return '[]';reads++;const n=Number(args[2].split('/').at(-1));
  if(n===1&&mode==='missing')return null;if(n===1&&mode==='throws')throw Error('read failed');
  return JSON.stringify({url:args[2],number:n,title:'Neutral PR '+n,state:'OPEN',headRefOid:mode==='recovered'?'new-head-'+n:'old-head-'+n,statusCheckRollup:[{context:'jev-merge',state:mode==='recovered'&&n===1?'FAILURE':'SUCCESS',description:'Recorded gate'}]});
 }});
 const until=async predicate=>{const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw Error('PR refresh timed out');await new Promise(r=>setTimeout(r,5));}};
 try{
  adapter.start(()=>{});await until(()=>adapter.snapshot().prs.length===2&&!adapter.enriching);
  const before=adapter.snapshot().prs.find(p=>p.number===1);assert.equal(before.verdict,'ACT');assert.equal(before.freshness,'fresh');assert.equal(before.observedAt,new Date(at).toISOString());
  for(const failure of ['missing','throws']){
   mode=failure;cache.raw.at+=60000;const nextReads=reads+2;adapter.refresh();await until(()=>reads>=nextReads&&!adapter.enriching);
   const snap=adapter.snapshot(),bad=snap.prs.find(p=>p.number===1),good=snap.prs.find(p=>p.number===2);
   assert.equal(snap.stale,false);assert.equal(bad.freshness,'stale');assert.equal(bad.verdict,'UNKNOWN');assert.equal(bad.observedAt,before.observedAt);assert.match(bad.refreshError,/failed|unavailable/i);assert.equal(bad.historicalGate.verdict,'ACT');assert.equal(bad.historicalGate.observedAt,before.observedAt);assert.equal(good.freshness,'fresh');assert.equal(good.verdict,'ACT');assert.match(snap.sources.github,/unavailable|failed/);
   for(const [w,h] of [[160,50],[100,30]]){const st=initialState();open(st,'pr',bad.id,snap);const text=renderV3(snap,w,h,st).screen.lines().join('\n');assert.ok(text.includes('STALE'),`stale warning at ${w}x${h}`);assert.ok(text.includes('Historical ACT'),`historical label at ${w}x${h}`);}
  }
  mode='recovered';cache.raw.at+=60000;const nextReads=reads+2;adapter.refresh();await until(()=>reads>=nextReads&&!adapter.enriching);
  const recovered=adapter.snapshot().prs.find(p=>p.number===1);assert.equal(recovered.freshness,'fresh');assert.equal(recovered.verdict,'HOLD');assert.equal(recovered.observedAt,new Date(cache.raw.at).toISOString());assert.equal(recovered.refreshError,null);assert.equal(recovered.historicalGate,undefined);assert.equal(adapter.snapshot().sources.github,'ok');
 }finally{adapter.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('fleet headline includes decisions and other on-track project names',()=>{
 const seat=rig=>({rig,pod:'impl',name:'builder',session:`builder@${rig}`,kind:'agent',activity:'working',model:null,ctx:null,why:null});
 const s=snapshotFromRaw(raw({rigs:['alpha','beta','gamma'].map(name=>({id:name,name,seats:[seat(name)]})),queue:[row('decision',{destination:'owner@external',humanIntent:'decision'}),row('beta-work',{source:'lead@beta',destination:'builder@beta',state:'in-progress'})]}));
 assert.match(s.headline,/1 decision needs you/);assert.match(s.headline,/beta.*gamma.*on track/i);assert.doesNotMatch(s.headline.split('. ').at(-1),/alpha/);
});

test('card text removes queue wrappers and IDs without removing meaningful human wording',()=>{
 const scope={name:'Example Portal',description:'Neutral project',milestone:'M03 — Booking journeys',progress:null,eta:null,milestones:[],activeMissions:[{id:'M03',label:'M03 — Booking journeys',status:'building'}]};
 const s=snapshotFromRaw(raw({queue:[row('qitem-20261002120000-abcdef12',{state:'in-progress',summary:'Queue row qitem-20261002120000-abcdef12: T035 — Review row-level access for ISO 27001 and Q4 reporting.'})]}),{projects:{alpha:scope}});
 assert.equal(s.teams[0].sentence,'Booking journeys: Review row-level access for ISO 27001 and Q4 reporting.');
 assert.equal(s.tasks[0].title,'Queue row qitem-20261002120000-abcdef12: T035 — Review row-level access for ISO 27001 and Q4 reporting.','detail titles retain the authored text');
});

test('planned-wait card copy explains resumption without internal queue vocabulary',()=>{
 const scope={name:'Example Portal',description:'Neutral project',milestone:'Booking journeys',progress:null,eta:null,milestones:[],activeMissions:[{id:'booking',label:'Booking journeys',status:'building'}]};
 const s=snapshotFromRaw(raw({queue:[row('park',{state:'blocked',waiting:{nextBackstop:{mechanism:'watchdog:later',dueAt:new Date(at+60000).toISOString()}}})]}),{projects:{alpha:scope}});
 assert.match(s.teams[0].sentence,/Booking journeys:.*scheduled to resume/i);assert.doesNotMatch(s.teams[0].sentence,/parked|wake|qitem|row/i);assert.equal(s.teams[0].status,'waiting');
});

test('healthy headline says no decisions need the owner without claiming stale projects are on track',()=>{
 const input=raw({rigs:[{id:'alpha',name:'alpha',seats:[{rig:'alpha',pod:'impl',name:'builder',session:'builder@alpha',kind:'agent',activity:'working',model:null,ctx:null,why:null}]}]});
 assert.equal(snapshotFromRaw(input).headline,'No decisions need you. alpha is on track.');
 assert.equal(snapshotFromRaw({...input,daemon:{ok:false,error:'offline'}}).headline,'Fleet data is stale.');
});

test('mission wrappers are removed before exact known identifiers, preserving subject tokens',()=>{
 for(const wrapper of ['Mission — ', 'Mission: ']){
  assert.equal(cardText(wrapper+'M0 — Repository housekeeping',['M0']),'Repository housekeeping');
  assert.equal(cardText(wrapper+'M0 — ISO 27001 and Q4 reporting',['M0']),'ISO 27001 and Q4 reporting');
 }
 assert.equal(cardText('Mission — M01 — Identity (D-27)',['M0']),'M01 — Identity (D-27)');
 assert.equal(cardText('Mission control for Q4'),'Mission control for Q4');
});

test('multiple missions leave room for the work clause and retain complete detail labels',()=>{
 const labels=['Repository housekeeping and executable design references','Identity (D-27): app access','Booking journeys for ISO 27001 and Q4'];
 const scope={name:'Example Portal',description:'Neutral project',milestone:labels.join(' · '),progress:null,eta:null,milestones:labels.map((label,i)=>({id:String(i),label,state:'active',detail:label,at:null})),activeMissions:labels.map((label,i)=>({id:'M'+i,label:'Mission — M'+i+' — '+label,status:'building'}))};
 const s=snapshotFromRaw(raw({rigs:['alpha','beta','gamma','delta','epsilon'].map(name=>({id:name,name,seats:[]})),queue:[row('build',{state:'in-progress',summary:'Fix the date picker on mobile.'})]}),{projects:{alpha:scope}});
 assert.match(s.teams[0].sentence,/^Repository housekeeping.*\+2 more: Fix the date picker on mobile\.$/);
 assert.ok(s.teams[0].sentence.length<=80,s.teams[0].sentence);
 assert.ok(wrap(s.teams[0].sentence,26).length<=3,'work clause fits the three-line fleet card');
 assert.doesNotMatch(s.teams[0].sentence,/Mission|M0|Identity|ISO/);
 assert.equal(s.teams[0].milestone,scope.milestone);assert.deepEqual(s.teams[0].milestones,scope.milestones);
 const card=renderV3(s,160,50,initialState()).screen.lines().slice(27,30).map(line=>line.slice(4,30).trim()).join(' ');
 assert.match(card,/date picker/,'the actual fleet card shows the task subject');
});
