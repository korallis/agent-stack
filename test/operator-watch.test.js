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
node={'sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat()},'lastActivity':'same'}
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
node={'sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':stamp(now)},'lastActivity':'A'}
ans=[]
for change in ['stale','unknown','moving','recent','empty']:
 s={'inactiveSince':now-1800,'lastActivity':'A'}; n=json.loads(json.dumps(node)); rows=[dict(row)]
 if change=='stale': n['agentActivity']['sampledAt']=stamp(now-121)
 if change=='unknown': n['agentActivity']['state']='unknown'
 if change=='moving': n['lastActivity']='B'
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
if a[0]=='ps': print(json.dumps({'entries':[{'canonicalSessionName':'operator@test','sessionStatus':'running','agentActivity':{'state':'idle','sampledAt':now.isoformat()},'lastActivity':'A'}]}))
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
