import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'bin/agent-operator-watch');
function python(code) {
 const r = spawnSync('python3', ['-c', `import runpy,datetime,json\nm=runpy.run_path(${JSON.stringify(script)})\n${code}`], {encoding:'utf8'});
 assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout);
}
test('silent operator: wake after 15min, escalate 15min after wake; activity clears episode',()=>{
 const got=python(`
s={}; now=2000000000
node={'sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat()},'lastActivityAt':'same'}
rows=[{'qitemId':'old','state':'pending','tsCreated':datetime.datetime.fromtimestamp(now-3600,datetime.timezone.utc).isoformat()}]
def step(t):
 node['agentActivity']['sampledAt']=datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat()
 return m['observe'](s,node,rows,t)
a=[step(now),step(now+899),step(now+900)]
s['wakeAt']=now+900
a += [step(now+1799),step(now+1800)]
node['agentActivity']['state']='running'
a += [step(now+1801)]
print(json.dumps([a,s]))`);
 assert.deepEqual(got,[['observe','observe','wake','observe','escalate','active'],{}]);
});
test('recent rows, unknown/stale activity and output movement never trigger a wake',()=>{
 const got=python(`
now=2000000000
stamp=lambda t: datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat()
row={'qitemId':'x','state':'pending','tsCreated':stamp(now-3600)}
node={'sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':stamp(now)},'lastActivityAt':'A'}
ans=[]
for change in ['stale','unknown','moving','recent','empty']:
 s={'inactiveSince':now-1800,'lastActivity':'A'}; n=json.loads(json.dumps(node)); rows=[dict(row)]
 if change=='stale': n['agentActivity']['sampledAt']=stamp(now-121)
 if change=='unknown': n['agentActivity']['state']='unknown'
 if change=='moving': n['lastActivityAt']='B'
 if change=='recent': rows[0]['tsCreated']=stamp(now-899)
 if change=='empty': rows=[]
 ans.append(m['observe'](s,n,rows,now))
print(json.dumps(ans))`);
 assert.deepEqual(got,['unknown','unknown','observe','observe','clear']);
});
test('real CLI uses fixtures, failed wake is attempted once, escalation is durable and dry-run is read-only',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-watch-'));
 try {
  const state=join(root,'state.json'), calls=join(root,'calls');
  writeFileSync(join(root,'rig'),`#!/usr/bin/env python3
import json,sys,os,datetime
with open(os.environ['CALLS'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
a=sys.argv[1:]; now=datetime.datetime.now(datetime.timezone.utc)
if a[0]=='ps': print(json.dumps({'entries':[{'canonicalSessionName':'operator@test','sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':now.isoformat()},'lastActivityAt':'A'}]}))
elif a[:2]==['queue','list']: print(json.dumps([{'qitemId':'old','state':'pending','tsCreated':(now-datetime.timedelta(hours=1)).isoformat()}]))
elif a[0]=='send': sys.exit(1)
elif a[:2]==['queue','create']: print('{}')
else: sys.exit(2)
`,{mode:0o755});
  const run=(...args)=>spawnSync(script,['--operator','operator@test','--advisor','advisor@test','--state',state,...args],{env:{...process.env,PATH:`${root}:/usr/bin:/bin`,CALLS:calls},encoding:'utf8'});
  const old=Date.now()/1000-1900;
  writeFileSync(state,JSON.stringify({inactiveSince:old,lastActivity:'A'}));
  const before=readFileSync(state,'utf8'); let r=run('--dry-run'); assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(state,'utf8'),before); assert.equal(JSON.parse(r.stdout).action,'wake');
  r=run(); assert.equal(r.status,1,r.stderr); assert.ok(JSON.parse(readFileSync(state)).wakeAt);
  r=run(); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).action,'observe');
  let s=JSON.parse(readFileSync(state)); s.wakeAt=old; writeFileSync(state,JSON.stringify(s));
  r=run(); assert.equal(r.status,0,r.stderr); assert.ok(JSON.parse(readFileSync(state)).escalated);
  r=run(); assert.equal(r.status,0,r.stderr);
  const argv=readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(argv.filter(a=>a[0]==='send').length,1);
  const create=argv.filter(a=>a[0]==='queue'&&a[1]==='create'); assert.equal(create.length,1);
  assert.ok(create[0].includes('--body-file')); assert.ok(create[0].includes('--id'));
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('a short completed turn resets both wake and escalation using the full node API field',()=>{
 assert.deepEqual(python(`
now=2000000000
stamp=lambda t: datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat()
n={'sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':stamp(now)},'lastActivityAt':stamp(now-5)}
r=[{'state':'pending','tsCreated':stamp(now-3600)}]
ans=[]
for woke in [False,True]:
 s={'inactiveSince':now-1900,'lastActivity':None}
 if woke:s['wakeAt']=now-1000
 ans.append([m['observe'](s,n,r,now),s.get('wakeAt'),s['inactiveSince']])
print(json.dumps(ans))`),[['observe',null,2000000000],['observe',null,2000000000]]);
});

// 2026-10-02: the operator's model was cooling on every credential; each wake only ended in the proxy's 429.
test('model out: the wake is held, the hold survives 429 turns, the owner gets one FYI at 30 min, one resume when served again',()=>{
 const got=python(`
now=2000000000
stamp=lambda t: datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat()
rows=[{'qitemId':'old','state':'pending','tsCreated':stamp(now-3600)}]
node={'sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':stamp(now)},'lastActivityAt':'A'}
s={'inactiveSince':now-900,'lastActivity':'A'}
def at(t,served,last='A',state='idle'):
 node['agentActivity']={'state':state,'sampledAt':stamp(t)}; node['lastActivityAt']=last
 return m['observe'](s,node,rows,t,served)
out=[]
out.append([at(now,False),dict(s.get('cooling',{}))])
out.append([at(now+60,False)])
out.append([at(now+120,False,last='B'),'cooling' in s,'wakeAt' in s])   # a 429 turn: new episode, hold kept
out.append([at(now+1799,False,last='B')])
out.append([at(now+1800,False,last='B')])
s['cooling']['ownerNotified']=True
out.append([at(now+1860,False,last='B')])
out.append([at(now+1920,True,last='B')])
out.append([at(now+1920,None,last='B')])   # proxy unreadable mid-hold: unknown holds nothing, it wakes as before
s2={'inactiveSince':now-900,'lastActivity':'A'}
out.append([m['observe'](s2,dict(node,lastActivityAt='A',agentActivity={'state':'idle','sampledAt':stamp(now)}),rows,now,None)])
out.append([at(now+1980,False,state='running'),s])
s['cooling']={'since':now}
out.append([m['observe'](s,node,[],now+2000,False),s])
print(json.dumps(out))`);
 assert.deepEqual(got,[
  ['hold',{since:2000000000}], ['hold'], ['observe',true,false], ['hold'], ['notify-owner'], ['hold'],
  ['resume'], ['wake'], ['wake'], ['active',{}], ['clear',{}]]);
});

test('real CLI, model out: holds without sending, one owner FYI row (update, evidence) after 30 min, one resume, then normal',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-watch-cool-'));
 try {
  const state=join(root,'state.json'), calls=join(root,'calls'), served=join(root,'served.json');
  writeFileSync(join(root,'rig'),`#!/usr/bin/env python3
import json,sys,os,datetime
with open(os.environ['CALLS'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
a=sys.argv[1:]; now=datetime.datetime.now(datetime.timezone.utc)
if a[0]=='ps': print(json.dumps({'entries':[{'canonicalSessionName':'operator@test','runtime':'claude-code','model':'claude-opus-5-5','sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':now.isoformat()},'lastActivityAt':'A'}]}))
elif a[:2]==['queue','list']: print(json.dumps([{'qitemId':'old','state':'pending','tsCreated':(now-datetime.timedelta(hours=1)).isoformat()}]))
elif a[0]=='send' or a[:2]==['queue','create']: print('{}')
else: sys.exit(2)
`,{mode:0o755});
  writeFileSync(join(root,'agent-servable'),`#!/bin/sh\ncat >/dev/null; cat "${served}"\n`,{mode:0o755});
  const run=(...args)=>spawnSync(script,['--operator','operator@test','--advisor','advisor@test','--state',state,...args],
   {env:{PATH:`${root}:/usr/bin:/bin`,CALLS:calls,AGENT_OWNER_ADDRESS:'boss@external',HOME:root},encoding:'utf8'});
  const calls_=()=>readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse).filter(a=>a[0]==='send'||a[1]==='create');
  const t=Date.now()/1000;
  writeFileSync(state,JSON.stringify({inactiveSince:t-1900,lastActivity:'A'}));
  writeFileSync(served,JSON.stringify({servable:false,family:'claude',model:'claude-opus-5-5',back:'2026-10-02T20:00:00.000Z'}));
  let r=run('--dry-run'); assert.equal(JSON.parse(r.stdout).action,'hold'); assert.ok(!JSON.parse(readFileSync(state)).cooling,'dry run writes nothing');
  r=run(); assert.equal(r.status,0,r.stderr);
  const rep=JSON.parse(r.stdout); assert.equal(rep.action,'hold'); assert.deepEqual(rep.model,{family:'claude',model:'claude-opus-5-5',back:'2026-10-02T20:00:00.000Z'});
  assert.equal(calls_().length,0,'held: nothing sent');
  // 30 minutes into the hold: one FYI row for the owner
  let s=JSON.parse(readFileSync(state)); s.cooling.since=t-1801; writeFileSync(state,JSON.stringify(s));
  r=run(); assert.equal(JSON.parse(r.stdout).action,'notify-owner'); assert.equal(JSON.parse(r.stdout).delivered,true);
  r=run(); assert.equal(JSON.parse(r.stdout).action,'hold');
  const fyi=calls_(); assert.equal(fyi.length,1);
  const arg=(a,k)=>a[a.indexOf(k)+1];
  assert.equal(arg(fyi[0],'--destination'),'boss@external'); assert.equal(arg(fyi[0],'--human-intent'),'update');
  const ev=JSON.parse(readFileSync(arg(fyi[0],'--evidence-ref'),'utf8'));
  assert.deepEqual([ev.operator,ev.model,ev.back],['operator@test','claude-opus-5-5','2026-10-02T20:00:00.000Z']);
  // served again: one resume, then the episode goes on as a woken one (escalation armed), no second resume
  writeFileSync(served,JSON.stringify({servable:true,family:'claude',model:'claude-opus-5-5'}));
  r=run(); assert.equal(JSON.parse(r.stdout).action,'resume');
  s=JSON.parse(readFileSync(state)); assert.ok(!s.cooling && s.wakeAt);
  r=run(); assert.equal(JSON.parse(r.stdout).action,'observe');
  const sends=calls_().filter(a=>a[0]==='send'); assert.equal(sends.length,1);
  assert.match(sends[0][2],/your model is served again .* Pending rows waited while it was out: old\. Resume your queue\./);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('agent-servable: false with the time it is back when every credential cools on the model; true otherwise; null when the proxy is unreadable',()=>{
 const root=mkdtempSync(join(tmpdir(),'servable-'));
 try {
  const node={canonicalSessionName:'operator-agent@kernel',runtime:'claude-code',model:'claude-opus-5-5'};
  const back=new Date(Date.now()+5*3600e3).toISOString();
  const ask=(status)=>{
   writeFileSync(join(root,'agent-proxy-status'),status===null?'#!/bin/sh\nexit 1\n':`#!/bin/sh\necho '${JSON.stringify(status)}'\n`,{mode:0o755});
   const r=spawnSync(process.execPath,[join(repo,'orchestration/servable.js')],{input:JSON.stringify(node),encoding:'utf8',
    env:{PATH:`${root}:/usr/bin:/bin`,HOME:root,AGENT_STACK_STATE:join(root,'state')}});
   assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout);
  };
  const acct=(o={})=>({provider:'claude',status:'active',cooldowns:[],...o});
  assert.deepEqual(ask([acct({over_limit:true}),acct({cooldowns:[{scope:'model',model_key:'claude-opus-5-5',retry_at:back}]})]),
   {servable:false,family:'claude',model:'claude-opus-5-5',back});
  assert.deepEqual(ask([acct({cooldowns:[{scope:'model',model_key:'claude-opus-5-5',retry_at:back}]}),acct()]),{servable:true,family:'claude',model:'claude-opus-5-5'});
  assert.deepEqual(ask(null),{servable:null,family:'claude',model:'claude-opus-5-5'});
 } finally {rmSync(root,{recursive:true,force:true});}
});
