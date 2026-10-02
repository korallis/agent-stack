import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ALT_ON, ALT_OFF, detectDepth, dump, frame, type Depth, type Screen } from '../term.ts';
import { FleetAdapter } from './adapter.ts';
import { renderV3, commandItems } from './render.ts';
import { initialState, key, click, Input, VIEWS, open, selection } from './controller.ts';
import type { Snapshot, View, Hit, Adapter } from './types.ts';

export const HELP=`rig-console — read-only fleet console
  --view fleet|team|agent|task|pr|capacity
  --team ID --agent SESSION --task ID --pr ID
  --fixture FILE       neutral Snapshot JSON, no live reads
  --once --size WxH    one cached frame; never waits for the daemon
  --url URL --interval SECONDS --history FILE --color 24|256|16|0
  --legacy             old console until v3 acceptance
Terminal: minimum 100×30 cells; preferred 160×50. Resize smaller default windows.
Keys: 1–6 views, arrows/jk select, Enter open, Esc back, ? help,
: command palette, p pause, r refresh, q quit. Mouse opens rows/cards.
No decisions, tasks, sessions, or pull requests are changed by this console.
`;
export function args(argv:string[]){
 const a={view:'fleet' as View,team:null as string|null,agent:null as string|null,task:null as string|null,pr:null as string|null,fixture:null as string|null,once:false,size:null as [number,number]|null,depth:null as Depth|null,url:process.env.OPENRIG_URL||`http://127.0.0.1:${process.env.OPENRIG_PORT||7433}`,interval:5000,history:undefined as string|undefined,help:false};
 for(let i=0;i<argv.length;i++){
  const k=argv[i],v=()=>{if(i+1>=argv.length)throw Error(`${k} requires a value`);return argv[++i]};
  if(k==='--view'){const x=v();if(!VIEWS.includes(x as View))throw Error(`view must be ${VIEWS.join(', ')}`);a.view=x as View;}
  else if(['--team','--agent','--seat','--task','--pr'].includes(k)){const field=k==='--seat'?'agent':k.slice(2);(a as any)[field]=v();a.view=field as View;}
  else if(k==='--fixture')a.fixture=v();else if(k==='--once')a.once=true;
  else if(k==='--size'){const m=v().match(/^(\d+)x(\d+)$/);if(!m||Number(m[1])<1||Number(m[2])<1||Number(m[1])>500||Number(m[2])>200)throw Error('size must be WxH, at most 500x200');a.size=[Number(m[1]),Number(m[2])];}
  else if(k==='--color'){const n=v();if(!['0','16','256','24'].includes(n))throw Error('color must be 0,16,256,24');a.depth=Number(n) as Depth;}
  else if(k==='--url'){const u=new URL(v());if(!['http:','https:'].includes(u.protocol))throw Error('url must use http or https');a.url=u.toString().replace(/\/$/,'');}
  else if(k==='--interval'){const n=Number(v());if(!Number.isFinite(n)||n<2||n>600)throw Error('interval must be 2–600 seconds');a.interval=n*1000;}
  else if(k==='--history')a.history=v();else if(k==='--help'||k==='-h')a.help=true;else throw Error(`unknown argument ${k}`);
 }return a;
}
export function fixture(file:string):Snapshot{
 const st=fs.statSync(file);if(st.size>8*1024*1024)throw Error('fixture exceeds 8 MiB');
 const s=JSON.parse(fs.readFileSync(file,'utf8'));
 if(s.version!==1||!Number.isFinite(s.at)||typeof s.headline!=='string'||!['teams','agents','tasks','prs','capacity','decisions','events'].every(k=>Array.isArray(s[k])))throw Error('fixture must be a v3 Snapshot');
 return s;
}
const MOUSE_ON='\x1b[?1000h\x1b[?1006h',MOUSE_OFF='\x1b[?1000l\x1b[?1006l';
export async function runConsole(argv:string[]){
 const opt=args(argv);if(opt.help){process.stdout.write(HELP);return;}
 const state=initialState();Object.assign(state,{view:opt.view,teamId:opt.team,agentId:opt.agent,taskId:opt.task,prId:opt.pr});
 const adapter:Adapter|null=opt.fixture?null:new FleetAdapter({url:opt.url,interval:opt.interval,history:opt.history});
 let snapshot=opt.fixture?fixture(opt.fixture):adapter!.snapshot();
 const depth=opt.depth??detectDepth(process.env),size=():[number,number]=>opt.size??[process.stdout.columns||160,process.stdout.rows||50];
 selection(state,snapshot);
 if(opt.once){const [w,h]=size();process.stdout.write(dump(renderV3(snapshot,w,h,state).screen,depth));adapter?.stop();return;}
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('interactive mode needs a terminal; use --once');
 let previous:Screen|null=null,hits:Hit[]=[],scheduled:NodeJS.Timeout|null=null,escapeTimer:NodeJS.Timeout|null=null,ended=false;
 let selectedKey='';
 const select=()=>{const next=selection(state,snapshot),token=JSON.stringify(next);if(token!==selectedKey){selectedKey=token;adapter?.select(next);}};
 const draw=()=>{scheduled=null;if(ended)return;const [w,h]=size();const next=renderV3(snapshot,w,h,state);hits=next.hits;process.stdout.write(frame(next.screen,previous,depth));previous=next.screen;};
 const schedule=()=>{if(!scheduled&&!ended)scheduled=setTimeout(draw,35);};
 const cleanup=()=>{if(ended)return;ended=true;adapter?.stop();clearInterval(timer);if(scheduled)clearTimeout(scheduled);if(escapeTimer)clearTimeout(escapeTimer);process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write(MOUSE_OFF+ALT_OFF);};
 const quit=()=>{cleanup();process.exit(0);};
 const dispatch=(k:string)=>{
  const mouse=k.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if(mouse){const button=Number(mouse[1]);if(mouse[4]==='M'&&button===0)click(state,hits,Number(mouse[2])-1,Number(mouse[3])-1,snapshot);else if(mouse[4]==='M'&&(button===64||button===65))key(state,button===64?'k':'j',snapshot);select();schedule();return;}
  // Palette entries are the same sequence the renderer displays.
  if(state.command!==null&&['\x1b[A','\x1b[B'].includes(k)){const entries=commandItems(snapshot,state.command);state.selected=Math.max(0,Math.min(entries.length-1,state.selected+(k==='\x1b[A'?-1:1)));schedule();return;}
  let action:string|null=null;
  if(state.command!==null&&k==='\r'){
   const entries=commandItems(snapshot,state.command),entry=entries[Math.max(0,state.selected)];
   if(/^(refresh|pause|help|quit|q)$/.test(state.command.trim()))action=key(state,k,snapshot);
   else if(entry){state.command=null;open(state,entry.view,entry.id,snapshot);}else action=key(state,k,snapshot);
  }else{if(state.command!==null&&k!=='\r')state.selected=0;action=key(state,k,snapshot);}
  if(action==='quit'){quit();return;}if(action==='refresh')adapter?.refresh();else if(action)state.note=action;
  if(!state.paused&&adapter)snapshot=adapter.snapshot();select();schedule();
 };
 const input=new Input();
 const onData=(chunk:string)=>{if(escapeTimer)clearTimeout(escapeTimer);for(const k of input.feed(chunk))dispatch(k);if(input.pending)escapeTimer=setTimeout(()=>{for(const k of input.flush())dispatch(k)},35);};
 process.stdout.write(ALT_ON+MOUSE_ON);process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();process.stdin.on('data',onData);
 process.stdout.on('resize',()=>{previous=null;schedule();});process.once('SIGINT',quit);process.once('SIGTERM',quit);
 process.once('uncaughtException',error=>{cleanup();console.error('rig-console:',error.message);process.exit(1);});
 const timer=setInterval(()=>{if(state.paused)return;state.frame++;schedule();},1000);
 try{draw();select();adapter?.start(()=>{if(!state.paused){snapshot=adapter.snapshot();select();schedule();}});}catch(error){cleanup();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runConsole(process.argv.slice(2)).catch(e=>{process.stdout.write(MOUSE_OFF+ALT_OFF);console.error(`rig-console: ${e.message}`);process.exitCode=1;});
