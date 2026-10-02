import {test} from 'node:test';
import assert from 'node:assert/strict';
import {estimateEta, addWorkingDays, featureUnits, readFeatureHistory, FEATURE_HISTORY_LIMIT} from '../console/src/v3/eta.ts';
const now=Date.parse('2026-10-02T12:00:00Z');
const units=[{id:'a',done:true,completedAt:'2026-09-26T12:00:00Z'},{id:'b',done:true,completedAt:'2026-09-27T12:00:00Z'},{id:'c',done:true,completedAt:'2026-10-01T12:00:00Z'},{id:'d',done:false}];
const input=(extra={})=>({units,unit:'features',scope:'All project features',source:'Verified transitions',now,...extra});
test('ETA uses remaining units and dated completions over 14 calendar days normalized to UTC working days, including weekends',()=>{
 const e=estimateEta(input());assert.equal(e.remaining,1);assert.equal(e.completions,3);assert.equal(e.workingDays,10);assert.equal(e.rate,.3);assert.equal(e.date,'2026-10-08');assert.equal(e.earliest,null);assert.equal(e.latest,null);
});
test('fewer than three dated completions explains missing evidence; future dates and undone records never count',()=>{
 const e=estimateEta(input({units:[...units.map(u=>u.id==='c'?{...u,completedAt:'2026-10-03'}:u),{id:'e',done:false,completedAt:'2026-10-01'}]}));
 assert.equal(e.completions,2);assert.equal(e.date,null);assert.match(e.reason,/2.*3.*dated completions/);
 assert.match(estimateEta(input({units:units.map(u=>({...u,completedAt:null}))})).reason,/0.*3.*dated completions/);
});
test('invalid or duplicate inventory cannot yield a partial ETA',()=>{
 const duplicate=estimateEta(input({units:[...units,units[0]]}));assert.equal(duplicate.date,null);assert.equal(duplicate.remaining,null);assert.match(duplicate.reason,/inventory/i);
 const invalid=estimateEta(input({valid:false,reason:'Incomplete authored membership'}));assert.equal(invalid.date,null);assert.equal(invalid.remaining,null);assert.match(invalid.reason,/membership/);
});
test('working day addition skips weekends across year boundaries; complete scope has no forecast delay',()=>{
 assert.equal(addWorkingDays(Date.parse('2026-12-31T12:00:00Z'),2),'2027-01-04');
 assert.equal(addWorkingDays(Date.parse('2026-10-03T12:00:00Z'),1),'2026-10-05');
 assert.equal(estimateEta(input({units:units.filter(u=>u.done)})).date,'2026-10-02');
});
test('a range is only emitted with enough daily observations and a positive lower quartile',()=>{
 const dense=Array.from({length:14},(_,i)=>({id:String(i),done:true,completedAt:new Date(Date.UTC(2026,8,19+i,10)).toISOString()}));
 const e=estimateEta(input({units:[...dense,...Array.from({length:8},(_,i)=>({id:'todo'+i,done:false}))]}));
 assert.ok(e.earliest);assert.ok(e.latest);assert.ok(e.earliest<=e.date&&e.date<=e.latest);
});
test('feature identities must be stable, unique and have boolean current pass states',()=>{
 assert.equal(featureUnits([{passes:true}]),null);assert.equal(featureUnits([{id:'x',passes:true},{id:'x',passes:false}]),null);
 assert.equal(featureUnits([{id:'x',passes:'true'}]),null);assert.deepEqual(featureUnits({features:[{id:'x',passes:true}]}),[{id:'x',passes:true}]);
});
const head='a'.repeat(40),middle='b'.repeat(40),old='c'.repeat(40),boundary='d'.repeat(40);
test('pinned first-parent feature transitions include parent boundary, exclude imports, and dedupe re-completions of currently passing IDs',async()=>{
 const current=[{id:'repeat',passes:true},{id:'import',passes:true},{id:'reopened',passes:false}];
 const calls=[];const snapshots={
  [middle]:[{id:'repeat',passes:false},{id:'reopened',passes:true}],
  [old]:[{id:'repeat',passes:true},{id:'reopened',passes:true}],
  [boundary]:[{id:'repeat',passes:false},{id:'reopened',passes:false}],
 };
 const run=async(cmd,args)=>{calls.push(args);if(args.includes('log'))return `${head} ${Math.floor(now/1000)-60} ${middle}\n${middle} ${Math.floor(now/1000)-120} ${old}\n${old} ${Math.floor(now/1000)-180} ${boundary}\n`;if(args.includes('show'))return JSON.stringify(snapshots[args.at(-1).split(':')[0]]);return null;};
 const h=await readFeatureHistory('/repo',head,current,run,now);assert.equal(h.reason,null);
 assert.deepEqual(h.units.filter(u=>u.completedAt).map(u=>u.id),['repeat']);assert.equal(h.units[0].completedAt,new Date(now-60000).toISOString());
 assert.ok(calls[0].includes(head));assert.ok(calls[0].includes('--first-parent'));assert.ok(calls[0].some(s=>s.startsWith('--since-as-filter=')));assert.ok(calls.some(c=>c.includes(boundary+':features.json')));
});
test('an absent parent file is an import, while unreadable existing history and capped history invalidate the whole estimate',async()=>{
 const current=[{id:'a',passes:true}];const entry=`${head} ${Math.floor(now/1000)} ${boundary}\n`;
 const absent=await readFeatureHistory('/repo',head,current,async(c,a)=>a.includes('log')?entry:a.includes('ls-tree')?'':null,now);assert.equal(absent.reason,null);assert.equal(absent.units[0].completedAt,null);
 const failed=await readFeatureHistory('/repo',head,current,async(c,a)=>a.includes('log')?entry:null,now);assert.match(failed.reason,/history.*unavailable/i);
 const capped=await readFeatureHistory('/repo',head,current,async()=>entry.repeat(FEATURE_HISTORY_LIMIT+1),now);assert.match(capped.reason,/limit/i);assert.equal(capped.units[0].completedAt,null);
});
