import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {collectMergeCompletions, completionKey} from '../console/src/v3/merge-completions.ts';

const NOW=Date.parse('2026-10-02T12:00:00.000Z');
const repo='/tmp/acme';
const runFor=(pulls,remote='git@github.com:acme/widget.git')=>async(_bin,args)=>{
 if(args.includes('config'))return remote+'\n';
 if(args.includes('pr'))return JSON.stringify(pulls);
 throw new Error(`unexpected command: ${args.join(' ')}`);
};
function dbWith(rows){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'merge-completions-')),file=path.join(dir,'openrig.sqlite');
 const db=new DatabaseSync(file);db.exec('CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY, tags TEXT, state TEXT, body TEXT, evidence_ref TEXT)');
 const put=db.prepare('INSERT INTO queue_items VALUES (?, ?, ?, ?, ?)');for(const [id,tags,state='done',body='',ref=''] of rows)put.run(id,JSON.stringify(tags),state,body,ref);db.close();
 return {file,dir};
}
function cleanup(d){fs.rmSync(d,{recursive:true,force:true});}

test('maps the latest merged PR to an exact canonical mission/slice unit',async()=>{
 const {file,dir}=dbWith([
  ['q1',['project:acme','mission:build','slice:one','pr:12'],'handed-off'],
  ['q2',['project:acme','mission:build','slice:one','pr:13'],'done'],
  ['q3',['project:acme','mission:build','slice:one','pr:12'],'done'],
 ]);
 try{
  const out=await collectMergeCompletions({dbPath:file,now:NOW,run:runFor([
   {number:12,mergedAt:'2026-09-25T10:00:00Z',url:'https://github.com/acme/widget/pull/12',headRefOid:'a'.repeat(40)},
   {number:13,mergedAt:'2026-10-01T10:00:00Z',url:'https://github.com/acme/widget/pull/13',headRefOid:'b'.repeat(40)},
  ]),projects:[{projectId:'acme',repo,units:[{missionId:'build',missionDirectory:'m-build',sliceId:'one',sliceDirectory:'s-one'}]}]});
  const e=out.evidence[completionKey('acme','build','one')];assert.equal(e.pr,13);assert.equal(e.source,'latest mapped merged PR');assert.equal(e.at,'2026-10-01T10:00:00.000Z');
 }finally{cleanup(dir);}
});

test('does not map a PR URL from another repository or contradictory tags',async()=>{
 const {file,dir}=dbWith([
  ['bad-url',['project:acme','mission:build','slice:two','pr:4'],'done','https://github.com/other/widget/pull/4'],
  ['bad-project',['project:acme','project:other','mission:build','slice:three','pr:5']],
 ]);
 try{const out=await collectMergeCompletions({dbPath:file,now:NOW,run:runFor([{number:4,mergedAt:'2026-09-28T10:00:00Z',url:'https://github.com/acme/widget/pull/4'},{number:5,mergedAt:'2026-09-28T10:00:00Z',url:'https://github.com/acme/widget/pull/5'}]),projects:[{projectId:'acme',repo}]});assert.deepEqual(out.evidence,{});}
 finally{cleanup(dir);}
});

test('rejects incomplete capped GitHub results for that project only',async()=>{
 const {file,dir}=dbWith([['q',['project:acme','mission:build','slice:one','pr:7']]]);
 try{const pulls=Array.from({length:501},(_,i)=>({number:i+1,mergedAt:'2026-09-20T00:00:00Z',url:`https://github.com/acme/widget/pull/${i+1}`}));const out=await collectMergeCompletions({dbPath:file,now:NOW,run:runFor(pulls),projects:[{projectId:'acme',repo}]});assert.deepEqual(out.evidence,{});assert.match(out.unavailableProjects.acme,/cap|incomplete/i);}
 finally{cleanup(dir);}
});

test('ignores invalid, future and unmerged PR timestamps',async()=>{
 const {file,dir}=dbWith([['q',['project:acme','mission:build','slice:one','pr:1']],['q2',['project:acme','mission:build','slice:two','pr:2']]]);
 try{const out=await collectMergeCompletions({dbPath:file,now:NOW,run:runFor([{number:1,mergedAt:'2026-02-31T00:00:00Z',url:'https://github.com/acme/widget/pull/1'},{number:2,mergedAt:'2026-10-03T00:00:00Z',url:'https://github.com/acme/widget/pull/2'}]),projects:[{projectId:'acme',repo}]});assert.deepEqual(out.evidence,{});}
 finally{cleanup(dir);}
});

test('does not query GitHub for an empty or entirely unfinished inventory',async()=>{
 const {file,dir}=dbWith([['q',['project:acme','mission:build','slice:one','pr:1']]]);
 try{let calls=0;const run=async()=>{calls++;throw new Error('must not run');};const out=await collectMergeCompletions({dbPath:file,now:NOW,run,projects:[{projectId:'acme',repo,units:[]},{projectId:'unfinished',repo,units:[{missionId:'m',sliceId:'s',done:false}]}]});assert.deepEqual(out.evidence,{});assert.equal(calls,0);}
 finally{cleanup(dir);}
});

test('rejects ambiguous aliases and multiple PR references without shrinking scope',async()=>{
 const {file,dir}=dbWith([
  ['q1',['project:acme','mission:old','slice:one','pr:1']],
  ['q2',['project:acme','mission:build','slice:two','pr:1'],'done','https://github.com/acme/widget/pull/2'],
  ['q3',['project:acme','mission:build','slice:three','candidate:aaa','candidate:bbb','pr:1']],
 ]);
 try{const out=await collectMergeCompletions({dbPath:file,now:NOW,run:runFor([{number:1,mergedAt:'2026-10-01T00:00:00Z',url:'https://github.com/acme/widget/pull/1'},{number:2,mergedAt:'2026-10-01T00:00:00Z',url:'https://github.com/acme/widget/pull/2'}]),projects:[{projectId:'acme',repo,units:[{missionId:'a',missionAliases:['old'],sliceId:'one'},{missionId:'b',missionAliases:['old'],sliceId:'one'},{missionId:'build',sliceId:'two'},{missionId:'build',sliceId:'three'}]}]});assert.deepEqual(out.evidence,{});}
 finally{cleanup(dir);}
});

test('oversized queue row invalidates only its own project before a network query',async()=>{
 const {file,dir}=dbWith([['q1',['project:oversize','mission:build','slice:one','pr:1'],'done','x'.repeat(65537)],['q2',['project:good','mission:build','slice:one','pr:1']]]);
 try{const out=await collectMergeCompletions({dbPath:file,now:NOW,run:runFor([{number:1,mergedAt:'2026-10-01T00:00:00Z',url:'https://github.com/acme/widget/pull/1'}]),projects:[{projectId:'oversize',repo},{projectId:'good',repo}]});assert.match(out.unavailableProjects.oversize,/limit/);assert.ok(out.evidence['good/build/one']);assert.equal(Object.keys(out.queries).length,1);}
 finally{cleanup(dir);}
});

test('normalizes unique authored aliases to the canonical identity',async()=>{
 const {file,dir}=dbWith([['q',['project:acme','mission:M0','slice:old-name'],'done','','https://github.com/acme/widget/pull/1']]);
 try{const out=await collectMergeCompletions({dbPath:file,now:NOW,run:runFor([{number:1,mergedAt:'2026-10-01T00:00:00Z',url:'https://github.com/acme/widget/pull/1'}]),projects:[{projectId:'acme',repo,units:[{missionId:'M0-foundation',missionAliases:['M0'],sliceId:'S1',sliceAliases:['old-name'],done:true}]}]});assert.ok(out.evidence['acme/M0-foundation/S1']);}
 finally{cleanup(dir);}
});
