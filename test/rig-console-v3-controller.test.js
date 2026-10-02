import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initialState, key, command, click, Input, VIEWS, selection } from '../console/src/v3/controller.ts';
const s=JSON.parse(fs.readFileSync(new URL('../console/fixtures/v3.json',import.meta.url),'utf8'));
test('v3 drilldown follows actual linked team, agent, task and PR identities',()=>{
 const st=initialState();key(st,'l',s);key(st,'\r',s);assert.equal(st.view,'team');assert.equal(st.teamId,s.teams[1].id);
 key(st,'j',s);key(st,'\r',s);const a=s.agents.filter(a=>a.teamId===s.teams[1].id)[1];assert.equal(st.view,'agent');assert.equal(st.agentId,a.id);
 key(st,'\r',s);assert.equal(st.view,'task');assert.equal(st.taskId,a.taskId);
 key(st,'\r',s);assert.equal(st.view,'pr');assert.equal(st.prId,s.tasks.find(t=>t.id===a.taskId).prId);
 key(st,'\x1b',s);assert.equal(st.view,'task');key(st,'\x1b',s);assert.equal(st.view,'agent');key(st,'\x1b',s);assert.equal(st.view,'team');key(st,'\x1b',s);assert.equal(st.view,'fleet');
});
test('v3 view keys, command palette, help and pause are read-only state changes',()=>{
 const before=JSON.stringify(s),st=initialState();
 for(let n=1;n<=6;n++){key(st,String(n),s);assert.equal(st.view,VIEWS[n-1]);}
 key(st,'?',s);assert.equal(st.help,true);key(st,'\x1b',s);assert.equal(st.help,false);
 key(st,'p',s);assert.equal(st.paused,true);key(st,'p',s);assert.equal(st.paused,false);
 key(st,':',s);for(const ch of 'agent '+s.agents[2].id)key(st,ch,s);key(st,'\r',s);assert.equal(st.agentId,s.agents[2].id);
 assert.match(command(st,'send something',s),/Unknown command/);assert.match(command(st,'task missing',s),/No task/);
 assert.equal(key(st,'r',s),'refresh');assert.equal(JSON.stringify(s),before);
});
test('v3 input keeps split arrows and mouse frames together and separates pasted keys',()=>{
 const input=new Input();assert.deepEqual(input.feed('\x1b['),[]);assert.deepEqual(input.feed('C2'),['\x1b[C','2']);
 assert.deepEqual(input.feed('\x1b[<0;12;'),[]);assert.deepEqual(input.feed('8M'),['\x1b[<0;12;8M']);
 assert.deepEqual(input.feed('\x1b'),[]);assert.deepEqual(input.flush(),['\x1b']);
 assert.deepEqual(input.feed(':team Atlas\r'),[':',...'team Atlas','\r']);
});
test('v3 mouse opens only bounded hits; overlays prevent click-through',()=>{
 const st=initialState(),hits=[{x:10,y:5,w:12,h:8,view:'team',id:'atlas'}];
 click(st,hits,22,8,s);assert.equal(st.view,'fleet');click(st,hits,15,8,s);assert.equal(st.teamId,'atlas');
 st.view='fleet';st.help=true;click(st,hits,15,8,s);assert.equal(st.view,'fleet');
});
test('empty and changing live snapshots cannot produce invalid selections or throw',()=>{
 const empty={...s,teams:[],agents:[],tasks:[],prs:[],decisions:[],capacity:[],events:[]},st=initialState();
 for(const view of VIEWS){st.view=view;for(const k of ['j','k','\r','\x1b'])assert.doesNotThrow(()=>key(st,k,empty));assert.ok(st.selected>=0);}
});

test('numeric views bind default identities and scroll retains the same agent',()=>{
 const st=initialState();key(st,'3',s);const chosen=selection(st,s);assert.equal(chosen.agentId,s.agents[0].id);
 key(st,'j',s);assert.equal(selection(st,s).agentId,chosen.agentId);
 key(st,'4',s);assert.equal(selection(st,s).taskId,s.agents[0].taskId);
 key(st,'5',s);assert.equal(selection(st,s).prId,s.tasks.find(t=>t.id===st.taskId).prId);
});

test('PR arrows select the displayed PR and palette begins at its first entry',()=>{
 const st=initialState();command(st,'pr '+s.prs[2].id,s);key(st,'j',s);assert.equal(st.prId,s.prs[3].id);
 key(st,':',s);assert.equal(st.selected,0);
});
test('page keys scroll task detail in both directions',()=>{const st=initialState();st.view='task';key(st,'\x1b[6~',s);assert.equal(st.scroll,5);key(st,'\x1b[5~',s);assert.equal(st.scroll,0);});
test('missing explicit identities have no unrelated Enter action',()=>{
 for(const view of ['team','agent','task']){const st=initialState();st.view=view;st[view+'Id']='gone';key(st,'\r',s);assert.equal(st.view,view);assert.equal(st.taskId,view==='task'?'gone':null);}
});
test('changing parent agent changes subsequent task and PR shortcuts',()=>{
 const st=initialState(),a=s.agents[1],b=s.agents[2];command(st,'agent '+a.id,s);key(st,'4',s);selection(st,s);key(st,'5',s);selection(st,s);
 command(st,'agent '+b.id,s);key(st,'4',s);selection(st,s);assert.equal(st.taskId,b.taskId);key(st,'5',s);selection(st,s);assert.equal(st.prId,s.tasks.find(t=>t.id===b.taskId).prId);
});

test('PR list navigation keeps its reverse task link coherent',()=>{const st=initialState();command(st,'pr '+s.prs[0].id,s);key(st,'j',s);key(st,'\x1b',s);assert.equal(s.tasks.find(t=>t.id===st.taskId).prId,s.prs[1].id);});
test('bracket detail scrolling reaches each individual evidence line',()=>{const st=initialState();st.view='pr';key(st,']',s);assert.equal(st.scroll,1);key(st,'[',s);assert.equal(st.scroll,0);});

test('late-loaded direct links acquire correct parent context without resetting scroll',()=>{const st=initialState();st.view='pr';st.prId=s.prs[3].id;st.scroll=5;selection(st,s);assert.equal(s.tasks.find(t=>t.id===st.taskId).prId,st.prId);assert.equal(st.teamId,s.prs[3].teamId);assert.equal(st.scroll,5);});

test('an agent without current work offers no historical task Enter action',()=>{
 const snap=structuredClone(s),a=snap.agents.find(a=>snap.tasks.find(t=>t.id===a.taskId)?.prId);a.taskId=null;
 const st=initialState();command(st,'agent '+a.id,snap);selection(st,snap);key(st,'4',snap);selection(st,snap);
 assert.equal(st.taskId,null);key(st,'\r',snap);assert.equal(st.view,'task');assert.equal(st.prId,null);
});
