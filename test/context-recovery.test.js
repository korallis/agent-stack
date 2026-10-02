import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
const script=join(dirname(fileURLToPath(import.meta.url)),'../bin/agent-context-recovery');
const py=code=>{const r=spawnSync('python3',['-c',`import runpy,json\nm=runpy.run_path(${JSON.stringify(script)})\n${code}`],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
test('only typed main-session API errors match; quotes, rate limits and successful continuation do not',()=>{
 assert.deepEqual(py(`
c={'type':'assistant','isApiErrorMessage':True,'apiErrorStatus':400,'timestamp':'2030-01-01T00:00:00Z','message':{'content':[{'type':'text','text':'API Error: prompt is too long'}]}}
x={'type':'event_msg','timestamp':c['timestamp'],'payload':{'type':'error','codex_error_info':'ContextWindowExceeded','message':'limit'}}
q=dict(c,isApiErrorMessage=False)
s=dict(c,isSidechain=True)
r=dict(c,apiErrorStatus=429)
a=[bool(m['latest_error']([c])),bool(m['latest_error']([x])),bool(m['latest_error']([q])),bool(m['latest_error']([s])),bool(m['latest_error']([r])),bool(m['latest_error']([c,q])),bool(m['latest_error']([x,{'type':'event_msg','payload':{'type':'agent_message','message':'fixed'}}]))]
print(json.dumps(a))`),[true,true,false,false,false,false,false]);
});
test('CLI rebuilds once from fresh recap after stable idle and refuses stale recap, working or unknown outcome retries',()=>{
 const root=mkdtempSync(join(tmpdir(),'context-recovery-'));
 try{
  const state=join(root,'state.json'),transcript=join(root,'events.jsonl'),recap=join(root,'RECAP.md'),calls=join(root,'calls');
  writeFileSync(recap,'# Recap\n\n## Next\nContinue q-fixture after restoring identity.\n');
  writeFileSync(transcript,JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),isApiErrorMessage:true,apiErrorStatus:400,message:{content:[{type:'text',text:'API Error: prompt is too long'}]}})+'\n');
  writeFileSync(join(root,'rig'),`#!/usr/bin/env python3
import json,os,sys,datetime
from pathlib import Path
r=Path(os.environ['FIXTURE']);a=sys.argv[1:]
with (r/'calls').open('a') as f:f.write(json.dumps(a)+'\\n')
if a[0]=='ps': print(json.dumps([{'canonicalSessionName':'impl@test','runtime':'claude-code','logicalId':'impl.a','sessionStatus':'running','lastActivityAt':'2030-01-01T00:00:00Z','agentActivity':{'state':('running' if os.environ.get('PREFLIGHT_BUSY') and (r/'calls').read_text().count('\"ps\"')>=2 else os.environ.get('ACTIVITY','idle')),'sampledAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},'contextUsage':{'transcriptPath':str(r/'events.jsonl'),'sessionId':'session-a'}}]))
elif a[:2]==['seat','status']: print(json.dumps({'current_occupant':'impl@test','handover_at':None}))
elif a[:2]==['queue','list']: print(json.dumps([{'tsUpdated':datetime.datetime.now(datetime.timezone.utc).isoformat()}]) if os.environ.get('NEW_QUEUE') else '[]')
elif a[:2]==['queue','create']: print('{}')
else:sys.exit(99)
`,{mode:0o755});
  writeFileSync(join(root,'agent-seat-recap'),`#!/usr/bin/env python3
import json,os
print(json.dumps({'chain':[{'path':os.environ['FIXTURE']+'/RECAP.md','exists':True}]}))
`,{mode:0o755});
  writeFileSync(join(root,'agent-seat-handover'),`#!/usr/bin/env python3
import os,json,sys
with open(os.environ['FIXTURE']+'/calls','a') as f:f.write(json.dumps(['HANDOVER']+sys.argv[1:])+'\\n')
sys.exit(int(os.environ.get('HANDOVER_RC','0')))
`,{mode:0o755});
  const run=(extra={},flags=[])=>spawnSync(script,['--rig','test','--recovery','recovery@test','--state',state,...flags],{env:{...process.env,PATH:`${root}:/usr/bin:/bin`,FIXTURE:root,...extra},encoding:'utf8'});
  const seed=()=>{writeFileSync(state,'{}');let r=run();assert.equal(r.status,0,r.stderr);const s=JSON.parse(readFileSync(state));for(const v of Object.values(s))v.idleSince-=61;writeFileSync(state,JSON.stringify(s));writeFileSync(calls,'');};
  seed();let r=run();assert.equal(r.status,0,r.stderr);assert.match(readFileSync(calls,'utf8'),/HANDOVER/);r=run();assert.equal((readFileSync(calls,'utf8').match(/HANDOVER/g)||[]).length,1);
  seed();utimesSync(recap,new Date(0),new Date(0));r=run();assert.doesNotMatch(readFileSync(calls,'utf8'),/HANDOVER/);assert.match(readFileSync(calls,'utf8'),/queue.*create/);
  utimesSync(recap,new Date(),new Date());seed();r=run({ACTIVITY:'running'});assert.doesNotMatch(readFileSync(calls,'utf8'),/HANDOVER/);
  seed();r=run({PREFLIGHT_BUSY:'1'});assert.doesNotMatch(readFileSync(calls,'utf8'),/HANDOVER/);
  seed();r=run({NEW_QUEUE:'1'});assert.doesNotMatch(readFileSync(calls,'utf8'),/HANDOVER/);
  seed();const unchanged=readFileSync(state,'utf8');r=run({},['--dry-run']);assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(state,'utf8'),unchanged);assert.doesNotMatch(readFileSync(calls,'utf8'),/HANDOVER/);
  seed();r=run({HANDOVER_RC:'3'});assert.match(readFileSync(calls,'utf8'),/HANDOVER/);r=run();assert.equal((readFileSync(calls,'utf8').match(/HANDOVER/g)||[]).length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
