import type { Snapshot, View, ViewState, Hit } from './types.ts';
export const VIEWS:View[]=['fleet','team','agent','task','pr','capacity'];
export const initialState=():ViewState=>({view:'fleet',teamId:null,agentId:null,taskId:null,prId:null,selected:0,scroll:0,help:false,command:null,frame:0,paused:false,note:null});
export function open(st:ViewState,view:View,id?:string,snapshot?:Snapshot){
  st.view=view;st.selected=0;st.scroll=0;st.help=false;
  if(view==='team'&&id){if(st.teamId!==id){st.agentId=null;st.taskId=null;st.prId=null;}st.teamId=id;}
  if(view==='agent'&&id){st.agentId=id;const a=snapshot?.agents.find(a=>a.id===id);st.taskId=a?.taskId??null;st.prId=snapshot?.tasks.find(t=>t.id===st.taskId)?.prId??null;if(a)st.teamId=a.teamId;}
  if(view==='task'&&id){st.taskId=id;const t=snapshot?.tasks.find(t=>t.id===id);st.prId=t?.prId??null;if(t?.teamId)st.teamId=t.teamId;if(t?.agentId)st.agentId=t.agentId;}
  if(view==='pr'&&id){st.prId=id;st.selected=Math.max(0,snapshot?.prs.findIndex(p=>p.id===id)??0);const t=snapshot?.tasks.find(t=>t.id===st.taskId&&t.prId===id)??snapshot?.tasks.find(t=>t.prId===id);st.taskId=t?.id??null;st.agentId=t?.agentId??null;const p=snapshot?.prs.find(p=>p.id===id);if(p?.teamId)st.teamId=p.teamId;}
}
/** Bind defaults to identities so scrolling cannot change the selected occupant. */
export function selection(st:ViewState,s:Snapshot){
 if(st.view==='team'&&!st.teamId)st.teamId=s.teams[0]?.id??null;
 if(st.view==='agent'&&!st.agentId)st.agentId=s.agents.find(a=>st.teamId===null||a.teamId===st.teamId)?.id??null;
 if(st.view==='task'&&!st.taskId)st.taskId=st.agentId!==null?(s.agents.find(a=>a.id===st.agentId)?.taskId??null):(s.tasks.find(t=>st.teamId===null||t.teamId===st.teamId)?.id??null);
 if(st.view==='pr'&&!st.prId)st.prId=st.taskId!==null?(s.tasks.find(t=>t.id===st.taskId)?.prId??null):(s.prs[0]?.id??null);
 if(st.view==='agent'){const a=s.agents.find(a=>a.id===st.agentId);if(a){st.teamId=a.teamId;st.taskId=a.taskId;st.prId=s.tasks.find(t=>t.id===a.taskId)?.prId??null;}}
 if(st.view==='task'){const t=s.tasks.find(t=>t.id===st.taskId);if(t){st.teamId=t.teamId;st.agentId=t.agentId;st.prId=t.prId;}}
 if(st.view==='pr'){const p=s.prs.find(p=>p.id===st.prId);if(p){const t=s.tasks.find(t=>t.id===st.taskId&&t.prId===p.id)??s.tasks.find(t=>t.prId===p.id);st.teamId=p.teamId;st.taskId=t?.id??null;st.agentId=t?.agentId??null;}}
 return {teamId:st.teamId,agentId:st.view==='agent'?st.agentId:null,taskId:st.view==='task'?st.taskId:null,prId:st.view==='pr'?st.prId:null};
}
export function candidates(s:Snapshot,st:ViewState):Hit[]{
  const hit=(view:View,id:string):Hit=>({x:0,y:0,w:0,h:0,view,id});
  if(st.view==='fleet')return s.teams.map(t=>hit('team',t.id));
  if(st.view==='team'){const team=st.teamId!==null?s.teams.find(t=>t.id===st.teamId):s.teams[0];return [...s.agents.filter(a=>a.teamId===team?.id).map(a=>hit('agent',a.id)),...s.tasks.filter(t=>t.teamId===team?.id).map(t=>hit('task',t.id))];}
  if(st.view==='agent'){const a=st.agentId!==null?s.agents.find(a=>a.id===st.agentId):s.agents.find(a=>st.teamId===null||a.teamId===st.teamId);return a?.taskId?[hit('task',a.taskId)]:[];}
  if(st.view==='task'){const t=st.taskId!==null?s.tasks.find(t=>t.id===st.taskId):s.tasks.find(t=>st.agentId!==null?t.id===s.agents.find(a=>a.id===st.agentId)?.taskId:st.teamId===null||t.teamId===st.teamId);return [...(t?.prId?[hit('pr',t.prId)]:[]),...(t?.agentId?[hit('agent',t.agentId)]:[])];}
  return st.view==='pr'?s.prs.map(p=>hit('pr',p.id)):[];
}
export function command(st:ViewState,line:string,s:Snapshot):string|null{
  const [name,...words]=line.trim().split(/\s+/),arg=words.join(' ');
  if(!name)return null;if(name==='quit'||name==='q')return 'quit';
  if(name==='help'){st.help=true;return null;}if(name==='refresh')return 'refresh';
  if(name==='pause'){st.paused=!st.paused;return null;}
  const view=({seat:'agent',rig:'team',pool:'capacity',home:'fleet'} as Record<string,View>)[name]??name as View;
  if(!VIEWS.includes(view))return `Unknown command: ${name}`;
  if(!arg){open(st,view);return null;}
  const rows=view==='team'?s.teams:view==='agent'?s.agents:view==='task'?s.tasks:view==='pr'?s.prs:[];
  const matches=rows.filter(x=>x.id===arg||('name'in x&&x.name===arg)||('number'in x&&String(x.number)===arg));
  if(matches.length!==1)return matches.length?'More than one match; use its full ID.':`No ${view} matches ${arg}`;
  open(st,view,matches[0].id,s);return null;
}
export function key(st:ViewState,k:string,s:Snapshot):string|null{
  if(st.command!==null){
    if(k==='\x1b'){st.command=null;return null;}
    if(k==='\x03')return 'quit';
    if(k==='\r'||k==='\n'){const line=st.command;st.command=null;return command(st,line,s);}
    if(k==='\x7f'||k==='\b')st.command=st.command.slice(0,-1);
    else if(k==='\t'){const m=[...VIEWS,'refresh','pause','help','quit'].filter(x=>x.startsWith(st.command!));if(m.length===1)st.command=m[0];}
    else if(/^[ -~]+$/.test(k))st.command+=k;
    return null;
  }
  if(k==='q'||k==='\x03')return 'quit';
  if(k==='['||k===']'){st.scroll=Math.max(0,st.scroll+(k==='['?-1:1));return null;}
  if(k==='\x1b[5~'||k==='\x1b[6~'){st.scroll=Math.max(0,st.scroll+(k==='\x1b[5~'?-5:5));return null;}
  if(k==='?'){st.help=!st.help;return null;}
  if(k===':'){st.command='';st.selected=0;return null;}
  if(k==='r')return 'refresh';if(k==='p'){st.paused=!st.paused;return null;}
  if(k==='\x1b'){if(st.help)st.help=false;else open(st,st.view==='agent'?'team':st.view==='task'?'agent':st.view==='pr'?'task':'fleet');return null;}
  if(/^[1-6]$/.test(k)){open(st,VIEWS[Number(k)-1]);return null;}
  const options=candidates(s,st),delta=['j','l','\x1b[B','\x1b[C','\t'].includes(k)?1:['k','h','\x1b[A','\x1b[D'].includes(k)?-1:0;
  if(delta){st.selected=Math.max(0,Math.min(Math.max(0,options.length-1),st.selected+delta));if(st.view==='pr'&&options[st.selected])open(st,'pr',options[st.selected].id,s);if(st.view==='agent'||st.view==='capacity'||st.view==='task')st.scroll=Math.max(0,st.scroll+delta);return null;}
  if(k==='\r'||k==='\n'){const item=options[st.selected];if(item)open(st,item.view,item.id,s);}
  return null;
}
export function click(st:ViewState,hits:Hit[],x:number,y:number,s:Snapshot){
  if(st.help||st.command!==null)return;
  const hit=[...hits].reverse().find(h=>x>=h.x&&x<h.x+h.w&&y>=h.y&&y<h.y+h.h);
  if(hit)open(st,hit.view,hit.id,s);
}
/** Streaming input tokenizer keeps fragmented arrow and SGR mouse sequences intact. */
export class Input {
  pending='';
  feed(chunk:string):string[]{this.pending+=chunk;const out:string[]=[];
    while(this.pending){
      if(this.pending.startsWith('\x1b[')){
        const m=this.pending.match(/^\x1b\[(?:<\d+;\d+;\d+[Mm]|[0-9;]*[A-Za-z~])/);
        if(m){out.push(m[0]);this.pending=this.pending.slice(m[0].length);continue;}
        if(this.pending.length<64)break;this.pending=this.pending.slice(1);out.push('\x1b');continue;
      }
      if(this.pending==='\x1b')break;
      const ch=[...this.pending][0];out.push(ch);this.pending=this.pending.slice(ch.length);
    }return out;
  }
  flush():string[]{const text=this.pending;this.pending='';return [...text];}
}
