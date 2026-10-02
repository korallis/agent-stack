import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
const root=path.resolve(import.meta.dirname,'..'), cli=path.join(root,'console/src/main.ts'),fixture=path.join(root,'console/fixtures/v3.json');
const base=process.env.TMPDIR??path.join(os.homedir(),'.cache/rig-console-tests');fs.mkdirSync(base,{recursive:true});
const plain=s=>s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
test('default CLI renders all six fixture views; legacy stays explicit',()=>{
 for(const view of ['fleet','team','agent','task','pr','capacity']){
  const r=spawnSync(process.execPath,[cli,'--fixture',fixture,'--view',view,'--once','--color','0'],{encoding:'utf8',timeout:2000});
  assert.equal(r.status,0,r.stderr);assert.match(plain(r.stdout),/rig console/);assert.equal(plain(r.stdout).trimEnd().split('\n').length,50);
 }
 for(const args of [['--view','missing'],['--size','999x900'],['--interval','0'],['--url','file:///etc/passwd']])assert.equal(spawnSync(process.execPath,[cli,...args],{encoding:'utf8'}).status,1);
});
test('cached --once starts under one second without contacting an unavailable daemon',async()=>{
 const scratch=fs.mkdtempSync(path.join(base,'wo97-cli-')),history=path.join(scratch,'history');let calls=0;
 const server=http.createServer((req,res)=>{calls++;res.destroy()});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 fs.writeFileSync(history+'.v3.json',fs.readFileSync(fixture));
 const start=performance.now();
 try{
  const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[cli,'--once','--history',history,'--url',`http://127.0.0.1:${server.address().port}`,'--color','0'],{env:{...process.env,HOME:scratch},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',code=>resolve({out,err,code}));});
  const elapsed=performance.now()-start;assert.equal(result.code,0,result.err);assert.ok(elapsed<1000,`${elapsed}ms`);assert.equal(calls,0);assert.match(plain(result.out),/Cached fleet data; connecting/);assert.match(plain(result.out),/Atlas/);assert.match(plain(result.out),/stale/);
 }finally{server.close();fs.rmSync(scratch,{recursive:true,force:true});}
});
