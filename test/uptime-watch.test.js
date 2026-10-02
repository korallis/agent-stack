import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
const repo=join(dirname(fileURLToPath(import.meta.url)),'..'), script=join(repo,'bin/agent-uptime-watch');
const py=code=>{const r=spawnSync('python3',['-c',`import runpy,json\nm=runpy.run_path(${JSON.stringify(script)})\n${code}`],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
test('continuous failure alerts after 15min, success and maintenance reset the outage',()=>{
 const got=py(`
s={}; a=[]
for t in range(0,901,60): a.append(m['observe'](s,False,False,t))
s['alerted']=True
a += [m['observe'](s,False,False,960),m['observe'](s,True,False,1020),m['observe'](s,False,False,1080),m['observe'](s,False,True,1140),m['observe'](s,False,False,1200)]
print(json.dumps([a,s['downSince']]))`);
 assert.deepEqual(got[0].slice(0,15),Array(15).fill('observe'));assert.deepEqual(got[0].slice(15),['alert','observe','healthy','observe','maintenance','observe']);assert.equal(got[1],1200);
});
test('observation gap restarts downtime; malformed maintenance windows are rejected',()=>{
 assert.deepEqual(py(`
s={'downSince':0,'checkedAt':60}
a=m['observe'](s,False,False,1000)
b=[]
for windows in [[{'start':'no','end':'no'}],[{'start':'2030-01-02T00:00:00Z','end':'2030-01-01T00:00:00Z'}]]:
 try: m['validate']([{'id':'stage','url':'https://example.test/health','destination':'ops@test','windows':windows}]); b.append(False)
 except ValueError: b.append(True)
print(json.dumps([a,s['downSince'],b]))`),['observe',1000,[true,true]]);
});
test('real HTTP failures create one queue alert; recovery rearms; dry-run does not mutate',async()=>{
 const root=mkdtempSync(join(tmpdir(),'uptime-watch-')); let status=503, healthyBody='ready';
 const server=http.createServer((req,res)=>{res.statusCode=status;res.end(status===200?healthyBody:'down');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const config=join(root,'config.json'), state=join(root,'state.json'), calls=join(root,'calls');
  const url=`http://127.0.0.1:${server.address().port}/health`;
  writeFileSync(config,JSON.stringify([{id:'fixture-stage',url,destination:'ops@test',bodyContains:'ready'}]));
  writeFileSync(join(root,'rig'),`#!/usr/bin/env python3
import os,sys,json
with open(os.environ['CALLS'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
print('{}')
`,{mode:0o755});
  const run=(...args)=>new Promise(resolve=>{const p=spawn(script,['--config',config,'--state',state,...args],{env:{...process.env,PATH:`${root}:/usr/bin:/bin`,CALLS:calls}});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',e=>resolve({code:127,out,err:e.message}));p.on('close',code=>resolve({code,out,err}));});
  const seed=()=>writeFileSync(state,JSON.stringify({'fixture-stage':{downSince:Date.now()/1000-901,checkedAt:Date.now()/1000}}));
  seed();const before=readFileSync(state,'utf8');let r=await run('--dry-run');assert.equal(r.code,0,r.err);assert.equal(readFileSync(state,'utf8'),before);assert.equal(JSON.parse(r.out)[0].action,'alert');
  r=await run();assert.equal(r.code,0,r.err);assert.equal(JSON.parse(r.out)[0].status,503);
  r=await run();assert.equal(r.code,0,r.err);assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,1);
  status=200;r=await run();assert.equal(JSON.parse(r.out)[0].action,'healthy');
  status=503;seed();r=await run();assert.equal(r.code,0,r.err);assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,2);
  status=302;r=await run('--dry-run');assert.equal(JSON.parse(r.out)[0].status,302);assert.notEqual(JSON.parse(r.out)[0].action,'healthy');
  status=200;healthyBody='login';r=await run('--dry-run');assert.notEqual(JSON.parse(r.out)[0].action,'healthy');
  const rows=readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);assert.ok(rows[0].includes('--body-file'));assert.ok(rows[0].includes('--id'));
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
});
test('validation rejects duplicate IDs, credentials, unsupported schemes and invalid destinations',()=>{
 const got=py(`
base={'id':'stage','url':'https://example.test/health','destination':'ops@test'}
ans=[]
for rows in [[base,base],[dict(base,url='https://user:secret@example.test')],[dict(base,url='file:///etc/passwd')],[dict(base,destination='oops')]]:
 try: m['validate'](rows); ans.append(False)
 except ValueError: ans.append(True)
print(json.dumps(ans))`);assert.deepEqual(got,[true,true,true,true]);
});
