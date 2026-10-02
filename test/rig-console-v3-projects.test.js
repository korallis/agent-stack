import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readProjectScopes} from '../console/src/v3/project-sources.ts';
const scratch=path.join(os.homedir(),'.cache','rig-console-tests');fs.mkdirSync(scratch,{recursive:true,mode:0o700});
function workspace(){const dir=fs.mkdtempSync(path.join(scratch,'projects-'));const work=path.join(dir,'Example-work');const put=(file,text)=>{fs.mkdirSync(path.dirname(path.join(work,file)),{recursive:true});fs.writeFileSync(path.join(work,file),text);};put('project.yaml','metadata:\n  id: example\n  name: Example Portal\n  description: Help people book training.\nmissions:\n  root: missions\n');put('rig/full-stack.yaml',`name: alpha\nworkspace:\n  workspace_root: ${path.join(dir,'Example')}\n`);return {dir,work,put};}
const mission=(status,refs)=>`metadata:\n  name: booking\n  status: ${status}\ncomposition:\n  slices:\n${refs.map((r,i)=>`  - ref: slices/${r}/slice.yaml\n    active: true\n    order: ${i}`).join('\n')}\n`;
test('workspace rig metadata maps project, authored active mission and origin/main feature progress',async()=>{
 const w=workspace();try{w.put('missions/booking/mission.yaml',mission('building',['a','b']));w.put('missions/booking/SPEC.md','# Booking journeys\n');w.put('missions/booking/slices/a/slice.yaml','metadata:\n  id: A\n');w.put('missions/booking/slices/a/SPEC.md','---\nstatus: done\n---\n# A\n');w.put('missions/booking/slices/b/slice.yaml','metadata:\n  id: B\n');w.put('missions/booking/slices/b/SPEC.md','---\nstatus: review\n---\n# B\n');const commands=[];
 const scopes=await readProjectScopes(w.dir,['alpha'],async(cmd,args)=>{commands.push([cmd,args]);return JSON.stringify([{id:'one',passes:true},{id:'two',passes:false},{id:'three',passes:false}]);});
 assert.equal(scopes.alpha.name,'Example Portal');assert.equal(scopes.alpha.description,'Help people book training.');assert.equal(scopes.alpha.milestone,'Booking journeys');assert.equal(scopes.alpha.progress,33);assert.match(scopes.alpha.progressLabel,/1\/3 project features pass.*origin\/main/);assert.equal(scopes.alpha.eta,null);assert.deepEqual(commands[0],['git',['-C',path.join(w.dir,'Example'),'rev-parse','origin/main']]);assert.ok(commands.some(([,args])=>args.includes('origin/main:features.json')));
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});
test('multiple active missions use an explicit combined slice-status scope, not accepted proof',async()=>{
 const w=workspace();try{for(const [m,state] of [['one','done'],['two','merged']]){w.put(`missions/${m}/mission.yaml`,mission('active',['a']));w.put(`missions/${m}/SPEC.md`,`# ${m}\n`);w.put(`missions/${m}/slices/a/slice.yaml`,'metadata:\n  id: A\n');w.put(`missions/${m}/slices/a/SPEC.md`,`---\nstatus: ${state}\n---\n`);}w.put('missions/later/mission.yaml',mission('planned',['a']));
 const scopes=await readProjectScopes(w.dir,['alpha'],async()=>null);assert.equal(scopes.alpha.progress,50);assert.match(scopes.alpha.progressLabel,/1\/2 slices marked done/);assert.equal(scopes.alpha.activeMissions.length,2);assert.match(scopes.alpha.milestone,/one.*two/);assert.doesNotMatch(scopes.alpha.progressLabel,/accepted|witnessed/);
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});
test('an unbound workspace cannot inject a project card and escaping members are excluded',async()=>{
 const w=workspace();try{w.put('missions/booking/mission.yaml',mission('active',['../../../../elsewhere']));const scopes=await readProjectScopes(w.dir,['other'],async()=>null);assert.deepEqual(scopes,{});const bound=await readProjectScopes(w.dir,['alpha'],async()=>null);assert.equal(bound.alpha.progress,null);assert.match(bound.alpha.progressLabel,/unavailable/i);}finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});

test('mixed or unsupported slice members make the whole membership progress unavailable',async()=>{
 const unsupported=[
  '    - {ref: slices/b/slice.yaml, active: true}',
  '    - slices/b/slice.yaml',
  '    - *another_slice',
  '    - ref: slices/b/slice.yaml\n      active: maybe',
  '    - ref: slices/b/slice.yaml\n      active: "false"',
  '    - ref: slices/b/slice.yaml\n      extra: true',
  '    - active: true',
  '    - ref: slices/b/slice.yaml\n      ref: slices/a/slice.yaml',
  '      - ref: slices/b/slice.yaml',
 ];
 for(const member of unsupported){const w=workspace();try{
  w.put('missions/m/mission.yaml',`metadata:\n  status: active\ncomposition:\n  slices:\n    - ref: slices/a/slice.yaml\n${member}\n`);
  for(const [id,status] of [['a','done'],['b','building']])w.put(`missions/m/slices/${id}/slice.yaml`,`metadata:\n  id: ${id}\n  status: ${status}\n`);
  const scope=(await readProjectScopes(w.dir,['alpha'],async()=>null)).alpha;
  assert.equal(scope.progress,null,member);assert.match(scope.progressLabel,/unavailable/i,member);
  assert.equal(scope.milestones.length,0,'Never present a supported subset as the complete mission');
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}}
});

test('complete block memberships retain indentless/indented lists, metadata and inactive slices',async()=>{
 for(const indent of ['  ','    ']){const w=workspace();try{
  w.put('missions/m/mission.yaml',`metadata:\n  status: active\ncomposition:\n  slices:\n${indent}- ref: 'slices/a/slice.yaml'\n${indent}  active: true\n${indent}  order: 0\n\n${indent}# a comment between members\n${indent}- ref: slices/b/slice.yaml\n${indent}  active: true\n${indent}  order: 1\n${indent}- ref: slices/c/slice.yaml\n${indent}  active: false # not part of this mission\n  other: ignored outside the list\n`);
  for(const [id,status] of [['a','done'],['b','building']])w.put(`missions/m/slices/${id}/slice.yaml`,`metadata:\n  id: ${id}\n  status: ${status}\n`);
  const scope=(await readProjectScopes(w.dir,['alpha'],async()=>null)).alpha;
  assert.equal(scope.progress,50);assert.match(scope.progressLabel,/1\/2 slices marked done/);assert.equal(scope.milestones.length,2);
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}}
});

test('mission display labels remove only leading identifiers and retain human subject details',async()=>{
 const w=workspace();try{
  w.put('missions/M03/mission.yaml',mission('building',['a']));w.put('missions/M03/SPEC.md','# M03 — Booking journeys for Q4 and ISO 27001\n');w.put('missions/M03/slices/a/slice.yaml','metadata:\n  id: A\n  status: building\n');
  const scope=(await readProjectScopes(w.dir,['alpha'],async()=>null)).alpha;
  assert.equal(scope.milestone,'Booking journeys for Q4 and ISO 27001');assert.equal(scope.activeMissions[0].id,'M03');
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});

const etaNow=Date.parse('2026-10-02T12:00:00Z');
function datedMission(w,name,status='building'){
 w.put(`missions/${name}/mission.yaml`,mission(status,['a','b','c','d']));w.put(`missions/${name}/SPEC.md`,`# ${name} milestone\n`);
 for(const [i,id] of ['a','b','c','d'].entries())w.put(`missions/${name}/slices/${id}/slice.yaml`,`metadata:\n  id: ${id}\n  status: ${i<3?'done':'building'}\n${i<3?`  completed_at: 2026-09-${27+i}T12:00:00Z\n`:''}`);
}
test('slice milestone and whole project ETA use their own complete authored inventory and explicit completion dates',async()=>{
 const w=workspace();try{
  datedMission(w,'current');datedMission(w,'future','planned');
  const s=(await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow)).alpha;
  assert.equal(s.progress,75);assert.equal(s.estimate.unit,'slices');assert.equal(s.estimate.remaining,1);assert.equal(s.estimate.completions,3);assert.equal(s.eta,'2026-10-08');assert.match(s.estimate.scope,/current milestone/);
  assert.equal(s.projectEstimate.remaining,2);assert.equal(s.projectEstimate.completions,6);assert.equal(s.projectEstimate.date,'2026-10-08');
  w.put('missions/future/mission.yaml','metadata:\n  status: planned\ncomposition:\n  slices: [*unsupported]\n');
  const partial=(await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow)).alpha;
  assert.equal(partial.estimate.date,'2026-10-08');assert.equal(partial.projectEstimate.date,null);assert.match(partial.projectEstimate.reason,/inventory unavailable/);
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});
test('created, verified and moved-on dates never become completion evidence; only exact done-slice evidence can supplement dates',async()=>{
 const w=workspace();try{
  datedMission(w,'current');for(const id of ['a','b','c','d']){
   w.put(`missions/current/slices/${id}/slice.yaml`,`metadata:\n  id: ${id}\n`);
   w.put(`missions/current/slices/${id}/SPEC.md`,`---\nstatus: ${id==='d'?'building':'done'}\ncreated: 2026-09-28\nverified: 2026-09-29\nmoved-on: 2026-09-30\n---\n`);
  }
  const missing=(await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow)).alpha;assert.equal(missing.eta,null);assert.equal(missing.estimate.completions,0);
  const completionEvidence=Object.fromEntries(['a','b','c','d'].map(id=>[`example/current/${id}`,{at:'2026-09-29T12:00:00Z',source:'Mapped final merged PR'}]));
  const supported=(await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow,{completionEvidence})).alpha;
  assert.equal(supported.estimate.completions,3);assert.equal(supported.estimate.remaining,1);assert.equal(supported.eta,'2026-10-08');assert.match(supported.estimate.source,/Mapped final merged PR/);
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});
test('feature history ETA pins the same revision as the ring and remains explicitly project-wide without a mission mapping',async()=>{
 const w=workspace();try{
  datedMission(w,'current');const head='a'.repeat(40),parent='b'.repeat(40),features=['one','two','three','four'].map((id,i)=>({id,passes:i<3}));const calls=[];
  const run=async(cmd,args)=>{calls.push(args);if(args.includes('rev-parse'))return head;if(args.includes('log'))return `${head} ${Math.floor(etaNow/1000)-3600} ${parent}\n`;if(args.includes(head+':features.json'))return JSON.stringify(features);if(args.includes(parent+':features.json'))return JSON.stringify(features.map(f=>({...f,passes:false})));return null;};
  const s=(await readProjectScopes(w.dir,['alpha'],run,etaNow)).alpha;
  assert.equal(s.progress,75);assert.equal(s.estimate.unit,'features');assert.equal(s.estimate.scope,'All project features');assert.equal(s.estimate.remaining,1);assert.equal(s.estimate.completions,3);assert.equal(s.eta,'2026-10-08');assert.deepEqual(s.estimate,s.projectEstimate);assert.ok(calls.some(a=>a.includes(head+':features.json')));assert.ok(!calls.some(a=>a.includes('origin/main:features.json')));
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});
test('authored README intro and plan outcome provide bounded purpose fallbacks',async()=>{
 const w=workspace();try{
  w.put('project.yaml','metadata:\n  id: example\nmissions:\n  root: missions\n');datedMission(w,'current');
  const repo=path.join(w.dir,'Example');fs.mkdirSync(path.join(repo,'docs'),{recursive:true});fs.writeFileSync(path.join(repo,'README.md'),'# Example portal\n\nA portal for booking local classes.\n\n## Setup\n');
  assert.equal((await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow)).alpha.description,'A portal for booking local classes.');
  fs.unlinkSync(path.join(repo,'README.md'));fs.writeFileSync(path.join(repo,'docs','PLAN.md'),'# Plan\n\n## The outcome\n\nHelp people arrange a lesson.\n\n## Delivery\n');
  assert.equal((await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow)).alpha.description,'Help people arrange a lesson.');
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});
test('completion resolver receives canonical inventory and fills only done slices without replacing authored dates',async()=>{
 const w=workspace();try{
  datedMission(w,'current');w.put('missions/current/slices/a/slice.yaml','metadata:\n  id: a\n  status: done\n');let calls=0;
  const s=(await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow,{completionResolver:async(project,at)=>{
   calls++;assert.equal(at,etaNow);assert.equal(project.projectId,'example');assert.equal(project.units.length,4);assert.equal(project.units[0].id,'current/a');
   return {'example/current/a':{at:'2026-09-27',source:'latest mapped merged PR'},'example/current/b':{at:'2027-01-01',source:'must not replace explicit date'},'example/current/d':{at:'2026-09-29',source:'must not count unfinished work'}};
  }})).alpha;
  assert.equal(calls,1);assert.equal(s.estimate.completions,3);assert.equal(s.eta,'2026-10-08');assert.match(s.estimate.source,/latest mapped merged PR/);assert.doesNotMatch(s.estimate.source,/must not/);
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});
test('mission discovery cap and duplicate membership cannot provide partial estimates',async()=>{
 const w=workspace();try{
  datedMission(w,'current');w.put('missions/current/mission.yaml',mission('building',['a','a']));
  let s=(await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow)).alpha;assert.equal(s.estimate.date,null);assert.equal(s.estimate.remaining,null);assert.equal(s.progress,null);
  for(let i=0;i<81;i++)w.put(`missions/m${i}/mission.yaml`,mission('active',[]));
  s=(await readProjectScopes(w.dir,['alpha'],async()=>null,etaNow)).alpha;assert.equal(s.projectEstimate.remaining,null);assert.equal(s.estimate.date,null);
 }finally{fs.rmSync(w.dir,{recursive:true,force:true})}
});
