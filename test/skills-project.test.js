import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const repo=join(dirname(fileURLToPath(import.meta.url)),'..');
const roots=['.claude/skills','.agents/skills','.grok/skills','.kimi-code/skills'];
function fixture(t){
 const home=fs.mkdtempSync('/tmp/skills-project-');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const put=(p,s)=>{fs.mkdirSync(dirname(join(home,p)),{recursive:true});fs.writeFileSync(join(home,p),s);};
 put('bin/herdr','#!/bin/sh\nprintf -- "---\\nname: herdr\\ndescription: Control Herdr\\n---\\nRequires HERDR_ENV=1\\n"\n');fs.chmodSync(join(home,'bin/herdr'),0o755);
 const skill=(p,body='shared')=>put(p+'/SKILL.md','---\nname: '+p.split('/').at(-1)+'\ndescription: test\n---\n'+body+'\n');
 const run=(...args)=>spawnSync(join(repo,'system/skills-project'),args,{encoding:'utf8',env:{HOME:home,PATH:join(home,'bin')+':/usr/bin:/bin'}});
 return {home,put,skill,run};
}
test('check writes nothing; apply shares user, grouped, system and plugin skills with all four harnesses',t=>{
 const f=fixture(t);f.skill('.agents/skills/shared');f.skill('.codex/skills/.system/codex-only');f.skill('.claude/skills/synced/group/account-only');f.skill('plugins/example/skills/plugin-only');f.skill('.local/share/agent-stack/openrig/lib/node_modules/@openrig/cli/daemon/specs/agents/shared/skills/process/role-only');
 f.put('.claude/plugins/installed_plugins.json',JSON.stringify({plugins:{'example@test':[{scope:'user',installPath:join(f.home,'plugins/example')}]}}));
 assert.equal(f.run('--json').status,1);assert.equal(fs.existsSync(join(f.home,'.local/share/agent-stack/skills')),false);
 const apply=f.run('--apply');assert.equal(apply.status,0,apply.stdout+apply.stderr);
 for(const root of roots)for(const name of ['shared','codex-only','account-only','plugin-only','role-only','herdr'])assert.ok(fs.existsSync(join(f.home,root,name,'SKILL.md')),root+'/'+name);
 assert.equal(f.run().status,0);const before=fs.readFileSync(join(f.home,'.local/share/agent-stack/skills/projection.json'),'utf8');assert.equal(f.run('--apply').status,0);assert.equal(fs.readFileSync(join(f.home,'.local/share/agent-stack/skills/projection.json'),'utf8'),before);
});
test('missing native link fails check and is repaired, but a conflicting user skill is preserved',t=>{
 const f=fixture(t);f.skill('.agents/skills/shared');assert.equal(f.run('--apply').status,0);
 fs.unlinkSync(join(f.home,'.grok/skills/shared'));assert.equal(f.run().status,1);assert.equal(f.run('--apply').status,0);
 fs.unlinkSync(join(f.home,'.kimi-code/skills/shared'));f.skill('.kimi-code/skills/shared','owner version');const r=f.run('--apply');assert.equal(r.status,1);assert.match(r.stdout,/preserve conflicting skill shared/);assert.match(fs.readFileSync(join(f.home,'.kimi-code/skills/shared/SKILL.md'),'utf8'),/owner version/);
});
test('failed Herdr extraction preserves the last installed skill and fails loudly',t=>{
 const f=fixture(t);f.skill('.agents/skills/shared');assert.equal(f.run('--apply').status,0);const p=join(f.home,'.local/share/agent-stack/skills/herdr/SKILL.md'),before=fs.readFileSync(p,'utf8');
 f.put('bin/herdr','#!/bin/sh\nexit 1\n');const r=f.run('--apply');assert.equal(r.status,1);assert.match(r.stdout,/cannot read herdr --skill/);assert.equal(fs.readFileSync(p,'utf8'),before);
});
test('release-matched Herdr output refreshes all linked consumers',t=>{
 const f=fixture(t);f.skill('.agents/skills/shared');assert.equal(f.run('--apply').status,0);
 fs.appendFileSync(join(f.home,'bin/herdr'),'printf "release two\\n"\n');assert.equal(f.run().status,1);assert.equal(f.run('--apply').status,0);
 for(const root of roots)assert.match(fs.readFileSync(join(f.home,root,'herdr/SKILL.md'),'utf8'),/release two/);
});
test('active Codex plugin contributes unique skills; ambiguous cache versions fail',t=>{
 const f=fixture(t);f.put('.codex/config.toml','[plugins."example@curated"]\nenabled = true\n');f.skill('.codex/plugins/cache/curated/example/one/skills/unique');assert.equal(f.run('--apply').status,0);
 assert.ok(fs.existsSync(join(f.home,'.grok/skills/unique/SKILL.md')));f.skill('.codex/plugins/cache/curated/example/two/skills/unique');const r=f.run();assert.equal(r.status,1);assert.match(r.stdout,/expected one installed skill version, found 2/);
});
