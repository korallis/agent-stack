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
 assert.equal(scopes.alpha.name,'Example Portal');assert.equal(scopes.alpha.description,'Help people book training.');assert.equal(scopes.alpha.milestone,'Booking journeys');assert.equal(scopes.alpha.progress,33);assert.match(scopes.alpha.progressLabel,/1\/3 project features pass.*origin\/main/);assert.equal(scopes.alpha.eta,null);assert.deepEqual(commands[0],['git',['-C',path.join(w.dir,'Example'),'show','origin/main:features.json']]);
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
