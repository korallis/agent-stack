import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {readProjectScopes, type ProjectScope} from './project-sources.ts';
import {cardText} from './wording.ts';
import { Cache, type Options } from '../data.ts';
import { classify, qrowFromItem, type Raw, type QRow } from '../model.ts';
import type { Adapter, Snapshot, Status, Step, PullRequest } from './types.ts';
import { acceptanceFromBody, bindVerdict, gateTargetFromGithub, getJson, MAX_BYTES, prFromGithub, prIdentity, progressFromExecution, readBounded, repoName, runRead, type Progress, type Run } from './sources.ts';
export interface Supplements { ownerAddress?:string; projects?:Record<string,ProjectScope>; lastDecision?:Snapshot['lastDecision']; details?:Record<string,QRow>; prs?:PullRequest[]; progress?:Record<string,Progress>; merges?:Record<string,{day:string;count:number}[]>; sources?:Record<string,string>; transitions?:Record<string,Step[]> }
export interface Measurements { capacity?:Record<string,{at:number;used:number;window?:'5h'|'weekly'}[]>; context?:Record<string,number[]> }
const status=(state:string):Status=>state==='blocked'?'blocked':state==='pending'?'waiting':state==='done'||state==='in-progress'?'ok':'unknown';
const stepState=(state:string):Step['state']=>state==='done'?'done':state==='in-progress'?'active':state==='blocked'?'blocked':state==='pending'?'waiting':'unknown';
const short=(text:unknown,limit=300)=>typeof text==='string'?text.trim().slice(0,limit):'';
const rigName=(session:string)=>session.includes('@')?session.split('@').at(-1):null;
const isOps=(name:string)=>name==='kernel'||name==='openrig-fix';
const liveWake=(row:QRow,now:number)=>!!row.waiting?.nextBackstop?.mechanism&&Number.isFinite(Date.parse(row.waiting.nextBackstop.dueAt??''))&&Date.parse(row.waiting.nextBackstop.dueAt!)>=now-60000;
function disposition(row:QRow,owner:string,now:number):{status:Status;reason:string} {
 if(row.state!=='blocked')return {status:status(row.state),reason:row.state};
 const blocker=row.waiting?.blocker?.ref??row.blockedOn??'',blockedOwner=row.waiting?.blocker?.owner;
 if(blocker===owner||blockedOwner===owner||/^human(?:-[\w.-]+)?@/.test(blocker))return {status:'blocked',reason:'Waiting for a person to decide'};
 const progressing=row.waiting?.liveness?.activity==='working'||row.waiting?.liveness?.activity==='running';
 if(/(?:outage|model[-_ ]out|model[-_ ]unavailable|pool[-_ ]empty|quota[-_ ]exhausted)/i.test([blocker,...row.tags].join(' '))&&!progressing)return {status:'blocked',reason:short(row.summary)||'A service or model is unavailable'};
 if(liveWake(row,now))return {status:'waiting',reason:'Waiting until the scheduled check'};
 if(row.waiting?.liveness?.activity==='stalled')return {status:'blocked',reason:'No progress or scheduled follow-up'};
 return {status:'waiting',reason:blocker?'Waiting for a dependency':'Waiting; follow-up time not reported'};
}

export function snapshotFromRaw(input:Raw,supplements:Supplements={},history:Measurements={}):Snapshot {
 const raw=classify(input),rigs=raw.rigs,owner=supplements.ownerAddress??'owner@external';
 const teamOf=(r:QRow)=>rigs.find(t=>t.name===rigName(r.destination))?.id??rigs.find(t=>t.name===rigName(r.source))?.id??null;
 const rows=[...new Map([...Object.values(supplements.details??{}),...(raw.done??[]),...raw.attention,...raw.queue].map(r=>[r.id,r])).values()].map(r=>{
  const detail=supplements.details?.[r.id];return detail?{...detail,...r,summary:detail.summary??r.summary,body:detail.body,humanDetail:detail.humanDetail,waiting:detail.waiting??r.waiting,evidenceRef:detail.evidenceRef??r.evidenceRef}:r;
 });
 const prs=supplements.prs??[],byId=new Map(rows.map(r=>[r.id,r]));
 const states=new Map(rows.map(r=>[r.id,disposition(r,owner,raw.at)]));
 for(const row of rows){if(row.state!=='blocked')continue;let upstream=row.blockedOn,seen=new Set<string>();while(upstream&&byId.has(upstream)&&!seen.has(upstream)){seen.add(upstream);if(states.get(upstream)?.status==='blocked'){states.set(row.id,states.get(upstream)!);break;}upstream=byId.get(upstream)?.blockedOn??null;}}
 const tasks=rows.map(r=>{
  const explicit=[r.body,r.summary,r.evidenceRef].filter(Boolean).join(' ').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
  const repo=repoName(r.targetRepo),n=Number(r.tags.find(t=>/^pr:\d+$/.test(t))?.slice(3));
  const prId=prs.find(p=>explicit&&prIdentity(p.url)?.url===prIdentity(explicit)?.url||repo&&n&&prIdentity(p.url)?.repo===repo.toLowerCase()&&p.number===n)?.id??null;
  const transitions=supplements.transitions?.[r.id]??(raw.transitions?.[r.id]??[]).map(t=>({id:String(t.id),label:t.state,state:stepState(t.state),at:t.ts,detail:`${t.actor}${t.note?' · '+t.note:''}`}));
  return {id:r.id,teamId:teamOf(r),title:short(r.summary)||`Task ${r.id}`,body:r.body??null,status:states.get(r.id)!.status,agentId:raw.rigs.flatMap(t=>t.seats).some(a=>a.session===r.destination)?r.destination:null,prId,acceptance:acceptanceFromBody(r.body),steps:transitions.length?transitions:[{id:r.id,label:r.state,state:stepState(r.state),at:r.updated??null,detail:r.blockedOn??'Transition history not loaded'}],createdAt:r.created??null,updatedAt:r.updated??null};
 });
 const decisions=rows.filter(r=>r.state==='pending'&&r.destination===owner&&r.humanIntent==='decision').map(r=>({id:r.id,teamId:teamOf(r),question:short(r.humanDetail)||short(r.summary)||'Decision details not loaded',blocks:r.blockedOn??null,createdAt:r.created}));
 const nativeOf=(rig:string,seat:Raw['rigs'][number]['seats'][number])=>{const native=supplements.projects?.[rig]?.nativeAgents?.[seat.session];return native&&seat.runtime==='te'&&seat.cwd&&path.resolve(seat.cwd)===path.resolve(native.cwd)?native:null;};
 const agents=rigs.flatMap(t=>t.seats.filter(a=>a.kind==='agent'||nativeOf(t.name,a)).map(a=>{
  const task=tasks.filter(q=>q.agentId===a.session&&rows.find(r=>r.id===q.id)?.state!=='done').sort((x,y)=>Number(rows.find(r=>r.id===y.id)?.state==='in-progress')-Number(rows.find(r=>r.id===x.id)?.state==='in-progress')||(y.updatedAt??'').localeCompare(x.updatedAt??''))[0];
  const tail=raw.tail?.session===a.session?raw.tail:null;
  return {id:a.session,teamId:t.id,name:a.name,model:nativeOf(t.name,a)?.model??a.model,status:(a.activity==='stuck'?'blocked':a.activity==='working'?'ok':a.activity==='idle'?(task?.status==='waiting'?'waiting':'ok'):'unknown') as Status,activity:`${a.why??a.activity}${task?' · '+task.title:''}`,taskId:task?.id??null,context:a.ctx,contextHistory:history.context?.[a.session]??[],tail:tail?.content??raw.tails?.[a.session]??null,tailAt:tail?.at??null,history:(raw.history??[]).filter(h=>h.actor===a.session).slice(0,40).map(h=>({id:String(h.id),label:h.change,state:'done' as const,at:h.ts,detail:h.summary??h.qitemId}))};
 }));
 const teams=rigs.map(t=>{
  const scope=supplements.projects?.[t.name],ops=isOps(t.name),name=ops?(t.name==='kernel'?'Operations':'Factory tooling'):scope?.name??t.name;
  const aa=agents.filter(a=>a.teamId===t.id),tt=tasks.filter(q=>q.teamId===t.id),teamRows=rows.filter(r=>teamOf(r)===t.id);
  const active=teamRows.filter(r=>r.state==='in-progress'),waits=teamRows.filter(r=>r.state==='blocked'&&states.get(r.id)?.status==='waiting');
  const blocking=teamRows.find(r=>states.get(r.id)?.status==='blocked'),needs=decisions.filter(d=>d.teamId===t.id).length;
  const held=prs.find(p=>p.teamId===t.id&&p.state==='OPEN'&&p.verdict==='HOLD');
  const gateProgress=held&&tt.filter(q=>q.prId===held.id).some(q=>{const r=byId.get(q.id);return r&&liveWake(r,raw.at)&&['working','running'].includes(r.waiting?.liveness?.activity??'');});
  const idle=aa.length>0&&aa.every(a=>a.status==='ok'&&byId.get(a.taskId??'')?.state!=='in-progress');
  const state:Status=needs||blocking||held&&!gateProgress||aa.some(a=>a.status==='blocked')?'blocked':active.length?'ok':waits.length||held||tt.some(q=>q.status==='waiting')?'waiting':idle||aa.some(a=>a.status==='ok')?'ok':'unknown';
  const reason=needs?'Your decision is needed':blocking?states.get(blocking.id)!.reason:held?`PR #${held.number} ${gateProgress?'is being rechecked':'held by merge gate'}`:active.length?'Work is moving':waits.length?(waits.every(r=>liveWake(r,raw.at))?'Scheduled to resume':'Waiting for the next step'):state==='ok'?'Ready for work':state==='waiting'?'Waiting for the next step':'Activity not reported';
  const current=active.filter(r=>r.summary).sort((a,b)=>Number(/(?:lead|deputy)/.test(b.destination))-Number(/(?:lead|deputy)/.test(a.destination))||b.updated.localeCompare(a.updated))[0];
  const mission=scope?.milestone??supplements.progress?.[t.id]?.milestone??null;
  const missions=scope?.activeMissions??[],first=cardText(missions[0]?.label??mission,missions[0]?[missions[0].id]:[]);
  const focus=missions.length>1?`${first.length>32?first.slice(0,31).trimEnd()+'…':first} +${missions.length-1} more`:first;
  const inFlight=prs.filter(p=>p.teamId===t.id&&p.state==='OPEN');
  const clause=needs?'Waiting for your decision.':blocking?reason:held&&!gateProgress?'A change needs attention before it can merge.':current?cardText(short(current.summary,170),[current.id])||'Work is moving.':waits.length?cardText(short(waits.find(r=>/witness/i.test(r.summary??''))?.summary,150))||(waits.every(r=>liveWake(r,raw.at))?'Work is scheduled to resume.':'Waiting for the next dependency or assignment.'):inFlight.length?`${inFlight.length===1?'One change is':`${inFlight.length} changes are`} in review.`:focus?reason:ops?(t.name==='kernel'?'Keeping the fleet running.':'Building and maintaining the agent tooling.'):reason;
  const cleanClause=cardText(clause)||'Activity not reported',prefix=focus&&cleanClause.toLowerCase().startsWith(focus.toLowerCase()+':')?'':focus?focus+': ':'';
  const punctuated=cleanClause+(/[.!?]$/.test(cleanClause)?'':'.'),sentence=missions.length>1?`${punctuated} ${focus}.`:prefix+punctuated;
  const progress=scope?{milestone:scope.milestone,progress:scope.progress,eta:scope.eta,milestones:scope.milestones}:supplements.progress?.[t.id]??{};
  return {id:t.id,name,description:ops?(t.name==='kernel'?'Fleet operations and human coordination.':'Builds and maintains the agent tooling.'):scope?.description??'',kind:ops?'operations' as const:'project' as const,status:state,reason,sentence,milestone:null,progress:null,eta:null,milestones:[],...(!ops?progress:{}),progressLabel:!ops?scope?.progressLabel??null:null,agentIds:aa.map(a=>a.id),taskIds:tt.map(q=>q.id),merges:supplements.merges?.[t.id]??null};
 });
 const stale=!raw.daemon.ok;
 const sources={...raw.sources,...supplements.sources,daemon:stale?`unavailable: ${raw.daemon.error??'stale'}`:raw.sources.daemon??'ok'};
 const capacity=raw.accounts.map(a=>({id:`${a.provider}:${a.label}`,provider:a.provider,label:a.label,used:a.short,weekly:a.weekly,resetAt:a.resetAt??null,cooldownUntil:a.coolUntil??null,credits:a.credits??(a.onCredits?'Using credits':null),status:(a.blocked||a.over?'blocked':a.cooling?'waiting':a.status==='active'?'ok':'unknown') as Status,reason:a.blocked?'Disabled':a.cooling?`${a.coolReason??'Cooling down'}${a.coolUntil?` until ${a.coolUntil}`:''}`:a.over?'Over limit':a.onCredits?'Using credits':a.status,history:history.capacity?.[`${a.provider}:${a.label}`]??[]}));
 const blocked=teams.filter(t=>t.status==='blocked').length;
 const projects=teams.filter(t=>t.kind==='project');
 const onTrack=projects.filter(t=>t.status==='ok').map(t=>t.name);
 const names=onTrack.length<2?onTrack[0]:onTrack.slice(0,-1).join(', ')+' and '+onTrack.at(-1);
 const healthy=onTrack.length?`${names} ${onTrack.length===1?'is':'are'} on track.`:'';
 const decisionText=decisions.length?`${teams.filter(t=>decisions.some(d=>d.teamId===t.id)).map(t=>t.name).slice(0,3).join(', ')||'Fleet'}: ${decisions.length} decision${decisions.length===1?' needs':'s need'} you.`:'No decisions need you.';
 const blockedText=!decisions.length&&blocked?teams.filter(t=>t.status==='blocked').slice(0,3).map(t=>`${t.name}: ${t.reason.toLowerCase()}`).join('; ')+'.':'';
 const workText=healthy||(!decisions.length&&!blocked?(projects.length?projects.slice(0,3).map(t=>`${t.name}: ${t.reason.toLowerCase()}`).join('; ')+'.':teams.length?'Fleet operations are running.':'No active teams reported.'):'');
 const headline=stale?'Fleet data is stale.':[decisionText,blockedText,workText].filter(Boolean).join(' ');
 return {version:1,at:raw.at,source:'OpenRig fleet',stale,sources,headline,teams,agents,tasks,prs,capacity,decisions,lastDecision:supplements.lastDecision??null,events:raw.events.slice(0,60).map((e,i)=>({id:`${e.at}:${i}`,at:e.at,teamId:rigs.find(t=>t.name===e.rig)?.id??null,text:e.text,status:(e.kind==='BLOCKED'?'blocked':e.kind==='DOWN'?'waiting':'ok') as Status}))};
}
type CacheLike=Pick<Cache,'raw'|'onChange'|'start'|'stop'|'soon'|'setSeat'|'setView'>;
export interface FleetOptions extends Options {history?:string|null;cacheFile?:string|null;cache?:CacheLike;run?:Run;projectsRoot?:string|null;ownerAddress?:string}
export class FleetAdapter implements Adapter {
 private cache:CacheLike;private current:Snapshot;private supplements:Supplements={details:{},progress:{},merges:{},sources:{},transitions:{}};
 private measurements:Measurements={capacity:{},context:{}};private onChange=()=>{};private stopped=false;private started=false;private enriching=false;private again=false;private selected:{teamId?:string|null;agentId?:string|null;taskId?:string|null;prId?:string|null}={};
 private file:string|null;private writtenAt=0;private lastEnrich=0;private ac=new AbortController();private opt:FleetOptions;private observed=0;private live=false;private observedSnapshot=false;private attempts=new Map<string,number>();private repoCache=new Map<string,string|null>();private ownerResolved=false;private ownerStarted=false;
 constructor(opt:FleetOptions) {
  this.opt=opt;this.supplements.ownerAddress=opt.ownerAddress??'owner@external';this.supplements.projects={};this.cache=opt.cache??new Cache({...opt,jevLog:null});this.file=opt.cacheFile===undefined?(opt.history?`${opt.history}.v3.json`:path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache'),'rig-console',`fleet-v3-${createHash('sha256').update(opt.url).digest('hex').slice(0,12)}.json`)):opt.cacheFile;
  this.current=snapshotFromRaw(this.cache.raw);
  if(this.file){try{const s=JSON.parse(readBounded(this.file)??'null');if(s?.version===1&&typeof s.at==='number'&&['teams','agents','tasks','prs','capacity','decisions','events'].every(k=>Array.isArray(s[k]))){this.observedSnapshot=true;this.current={...s,stale:true,headline:'Cached fleet data; connecting.',sources:{...s.sources,daemon:'cached; connecting'}};for(const c of s.capacity)this.measurements.capacity![c.id]=Array.isArray(c.history)?c.history.filter((p:any)=>p.window==='5h'||p.window==='weekly').slice(-1440):[];for(const a of s.agents)this.measurements.context![a.id]=Array.isArray(a.contextHistory)?a.contextHistory.slice(-120):[];}}catch{}}
  this.cache.onChange(()=>{if(this.stopped)return;const first=this.cache.raw.daemon.ok&&!this.live;if(this.cache.raw.daemon.ok)this.live=true;this.publish();void this.enrich(first);});
 }
 snapshot(){return this.current;}
 start(onChange:()=>void){this.onChange=onChange;if(this.started||this.stopped)return;this.started=true;this.cache.start();void this.resolveOwner();}
 stop(){this.stopped=true;this.ac.abort();this.cache.stop();}
 refresh(){this.lastEnrich=0;this.attempts.clear();this.cache.soon();void this.enrich();}
 select(selection:typeof this.selected){this.selected=selection;this.cache.setSeat(selection.agentId??null);this.cache.setView(!!selection.teamId,null);void this.enrich(true);}
 private publish(){
  if(this.stopped)return;const raw=this.cache.raw;
  if(raw.at-this.observed>=60000){this.observed=raw.at;
   if(raw.sources.accounts==='ok')for(const a of raw.accounts){const used=a.short??a.weekly;if(used===null)continue;const id=`${a.provider}:${a.label}`,samples=this.measurements.capacity![id]??[];samples.push({at:raw.at,used,window:a.short!==null?'5h':'weekly'});this.measurements.capacity![id]=samples.filter(s=>raw.at-s.at<=86400000).slice(-1440);}
   if(raw.daemon.ok)for(const a of raw.rigs.flatMap(t=>t.seats)){if(a.ctx!==null)this.measurements.context![a.session]=[...(this.measurements.context![a.session]??[]),a.ctx].slice(-120);}
  }
  const next=snapshotFromRaw(raw,this.supplements,this.measurements);
  if(raw.daemon.ok)this.observedSnapshot=true;else if(this.observedSnapshot)next.at=this.current.at;
  if(!raw.daemon.ok&&raw.rigs.length===0&&this.current.teams.length)this.current={...this.current,stale:true,headline:'Fleet data is stale.',sources:{...this.current.sources,...next.sources}};else this.current=next;
  this.onChange();
  if(this.file&&raw.daemon.ok&&Date.now()-this.writtenAt>=60000){this.writtenAt=Date.now();const file=this.file,data=JSON.stringify(this.current);if(Buffer.byteLength(data)<=MAX_BYTES)void (async()=>{const tmp=`${file}.${process.pid}.tmp`;try{await fs.promises.mkdir(path.dirname(file),{recursive:true});await fs.promises.writeFile(tmp,data,{mode:0o600});await fs.promises.rename(tmp,file);}catch{await fs.promises.rm(tmp,{force:true}).catch(()=>{});}})();}
 }
 private async resolveOwner(){
  if(this.ownerStarted)return;this.ownerStarted=true;
  const value=this.opt.ownerAddress??(await (this.opt.run??runRead)('agent-owner-address',[],4000))?.trim();
  if(this.stopped)return;this.ownerResolved=true;if(value&&/^[A-Za-z0-9][A-Za-z0-9._-]*@external$/.test(value))this.supplements.ownerAddress=value;
  this.supplements.sources!.owner='configured owner address';if(this.live)this.publish();void this.enrich(true);
 }
 private due(key:string,every=60000){const now=Date.now();if(now-(this.attempts.get(key)??0)<every)return false;this.attempts.set(key,now);return true;}
 private async json(route:string){return getJson(this.opt.url+route,AbortSignal.any([this.ac.signal,AbortSignal.timeout(this.opt.timeoutMs??4000)]));}
 private async enrich(selected=false){
  if(this.stopped||!this.started||!this.live||!this.cache.raw.daemon.ok)return;if(this.enriching){if(selected)this.again=true;return;}
  if(!selected&&Date.now()-this.lastEnrich<30000)return;this.lastEnrich=Date.now();this.enriching=true;
  const run=this.opt.run??runRead;
  try {
   const raw=this.cache.raw,all=[...raw.queue,...raw.attention,...(raw.done??[])];
   if(this.due('projects',120000)&&this.opt.projectsRoot!==null){
    this.supplements.projects=await readProjectScopes(this.opt.projectsRoot??path.join(os.homedir(),'Projects'),raw.rigs.map(r=>r.name),run);
    for(const team of raw.rigs){const p=this.supplements.projects[team.name];if(p)this.supplements.sources![`progress:${team.id}`]=p.source;}
   }
   if(this.due('waiting',30000)&&raw.queue.some(r=>r.state==='blocked')){
    try{const blocked=await this.json('/api/queue/list?state=blocked&limit=300');if(Array.isArray(blocked)){for(const r of blocked)if(r.qitemId&&r.state==='blocked')this.supplements.details![r.qitemId]=qrowFromItem(r);this.supplements.sources!.waiting=blocked.length===300?'300-row cap; other wake states unknown':'live wake records';}}catch{this.supplements.sources!.waiting='unavailable (wake state unknown)';}
   }
   if(this.ownerResolved&&this.due('last-decision',60000)){
    try{const owner=this.supplements.ownerAddress??'owner@external';const done=await this.json(`/api/queue/list?destinationSession=${encodeURIComponent(owner)}&state=done&limit=100`);
     if(Array.isArray(done)){for(const q of done.filter(r=>r.humanIntent==='decision'&&r.destinationSession===owner).sort((a,b)=>String(b.tsUpdated).localeCompare(String(a.tsUpdated))).slice(0,3)){
      const transitions=await this.json(`/api/queue/${encodeURIComponent(q.qitemId)}/transitions`);const answered=Array.isArray(transitions)?transitions.filter(t=>t.state==='done'&&t.actorSession===owner).sort((a,b)=>String(b.ts).localeCompare(String(a.ts)))[0]:null;
      if(answered){this.supplements.lastDecision={question:short(q.summary)||'Decision answered',answeredAt:answered.ts,answer:typeof q.resolution==='string'?q.resolution:null};break;}
     }}
    }catch{this.supplements.sources!.lastDecision='unavailable';}
   }
   const candidateIds=[this.selected.taskId,...all.filter(r=>r.state==='pending'&&r.destination===(this.supplements.ownerAddress??'owner@external')&&r.humanIntent==='decision').map(r=>r.id),...all.filter(r=>!this.selected.teamId||raw.rigs.find(t=>t.id===this.selected.teamId)?.name===rigName(r.destination)).slice(0,12).map(r=>r.id)];
   for(const id of [...new Set(candidateIds.filter((x):x is string=>!!x))].slice(0,16)){
    if(this.stopped)return;if(!this.due(`detail:${id}`))continue;
    try{const q=await this.json(`/api/queue/${encodeURIComponent(id)}`);if(q?.qitemId)this.supplements.details![id]=qrowFromItem(q);this.supplements.sources!.details='ok';}catch{this.supplements.sources!.details='unavailable (last known detail)';}
   }
   if(this.selected.taskId&&this.due(`transitions:${this.selected.taskId}`,30000)){
    const id=this.selected.taskId;try{const list=await this.json(`/api/queue/${encodeURIComponent(id)}/transitions`);if(Array.isArray(list))this.supplements.transitions![id]=list.slice(-100).map(t=>({id:String(t.transitionId),label:t.state??'Transition',state:stepState(t.state),at:t.ts??null,detail:`${t.actorSession??''} ${t.transitionNote??''}`.trim()}));}catch{this.supplements.sources!.transitions='unavailable';}
   }
   this.publish();
   const details=all.map(r=>this.supplements.details![r.id]??r),refs=new Map<string,string|null>();
   for(const r of details){
    const teamId=raw.rigs.find(t=>t.name===rigName(r.destination)||t.name===rigName(r.source))?.id??null;
    for(const url of [r.body,r.summary,r.evidenceRef].filter(Boolean).join(' ').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)??[])refs.set(url,teamId);
    const n=r.tags.find(t=>/^pr:\d+$/.test(t))?.slice(3);let repo=repoName(r.targetRepo);
    if(n&&!repo&&r.targetRepo?.startsWith('/')){if(this.due(`repo:${r.targetRepo}`,300000))this.repoCache.set(r.targetRepo,repoName((await run('git',['-C',r.targetRepo,'remote','get-url','origin'],3000))?.trim()));repo=this.repoCache.get(r.targetRepo)??null;}
    if(n&&repo)refs.set(`https://github.com/${repo}/pull/${n}`,teamId);
   }
   const log=this.opt.jevLog??path.join(os.homedir(),'.local/state/agent-stack/jev-decisions.jsonl');
   const gateText=readBounded(log,MAX_BYTES,true);this.supplements.sources!.gates=gateText===null?'unavailable':'latest 4 MiB; explicit PR identity required';
   const records=(gateText??'').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
   const targets=[...refs].sort(([a],[b])=>Number(b===this.selected.prId)-Number(a===this.selected.prId)).slice(0,6);
   for(const [url,teamId] of targets){
    if(this.stopped)return;if(!this.due(`pr:${url}`))continue;
    const identity=prIdentity(url)?.url??url,sourceKey=`github:${identity}`;
    try{
     const text=await run('gh',['pr','view',url,'--json','number,title,url,state,headRefOid,additions,deletions,files,statusCheckRollup,reviews,mergedAt,updatedAt'],5000);
     const p=JSON.parse(text??'null');if(!p||prIdentity(p.url)?.url!==identity)throw Error('invalid PR');
     const pr:PullRequest={...bindVerdict(prFromGithub(p,teamId),records,p.headRefOid??null,gateTargetFromGithub(p)),observedAt:new Date((this.opt.now??Date.now)()).toISOString(),freshness:'fresh',refreshError:null};
     this.supplements.prs=[...(this.supplements.prs??[]).filter(x=>prIdentity(x.url)?.url!==identity),pr];
     this.supplements.sources![sourceKey]='ok';
    }catch{
     const error='GitHub PR refresh failed; current head and gate unavailable';
     this.supplements.prs=(this.supplements.prs??[]).map(pr=>prIdentity(pr.url)?.url!==identity?pr:{
      ...pr,observedAt:pr.observedAt??null,freshness:'stale',refreshError:error,
      historicalGate:pr.historicalGate??{verdict:pr.verdict,reason:pr.reason,observedAt:pr.observedAt??null},
      verdict:'UNKNOWN',band:null,signals:[],reason:error,
     });
     this.supplements.sources![sourceKey]='unavailable (last successful PR data is historical)';
    }
    const failures=Object.entries(this.supplements.sources!).filter(([key,value])=>key.startsWith('github:')&&value!=='ok').length;
    this.supplements.sources!.github=failures?`unavailable: ${failures} PR refresh${failures===1?'':'es'} failed`:'ok';
    this.publish();
   }
   const ordered=[...raw.rigs].sort((a,b)=>Number(b.id===this.selected.teamId)-Number(a.id===this.selected.teamId)||(this.attempts.get(`progress:${a.id}`)??0)-(this.attempts.get(`progress:${b.id}`)??0));
   let progressReads=0;
   for(const team of ordered){
    if(this.supplements.projects?.[team.name]||isOps(team.name))continue;
    const rows=raw.queue.filter(r=>rigName(r.destination)===team.name);
    const pairOf=(r:QRow)=>{const project=r.tags.find(t=>t.startsWith('project:'))?.slice(8),mission=r.tags.find(t=>t.startsWith('mission:'))?.slice(8);return project&&mission?JSON.stringify([project,mission]):null;};
    const activePairs=[...new Set(rows.filter(r=>r.state==='in-progress').map(pairOf).filter((p):p is string=>!!p))];
    const pairs=activePairs.length?activePairs:[...new Set(rows.map(pairOf).filter((p):p is string=>!!p))];
    if(pairs.length!==1){delete this.supplements.progress![team.id];this.supplements.sources![`progress:${team.id}`]=pairs.length?'Unknown: multiple live mission bindings':'Unknown: no explicit project and mission binding';continue;}
    if(progressReads>=2||!this.due(`progress:${team.id}`,120000))continue;progressReads++;
    const [project,mission]=JSON.parse(pairs[0]);
    try{const value=await this.json(`/api/views/execution?project=${encodeURIComponent(project)}&mission=${encodeURIComponent(mission)}`),e=value?.rows?.[0];if(!e||e.project!==project)throw Error('missing execution view');this.supplements.progress![team.id]=progressFromExecution(e);this.supplements.sources![`progress:${team.id}`]=`${activePairs.length?'Unique in-progress assignment':'Unique open-work binding'}; attributed proof readiness`;}catch{this.supplements.sources![`progress:${team.id}`]='unavailable (last known proof)';}
   }
   // A team can own a repository's merge chart only when no other visible team is bound to it.
   const byRepo=new Map<string,Set<string>>();for(const [url,teamId] of refs){const repo=prIdentity(url)?.repo;if(repo&&teamId)(byRepo.get(repo)??byRepo.set(repo,new Set()).get(repo)!).add(teamId);}
   const repoCount=new Map<string,number>();for(const teams of byRepo.values())for(const team of teams)repoCount.set(team,(repoCount.get(team)??0)+1);
   let mergeReads=0;
   for(const [repo,teams] of byRepo){if(mergeReads>=2)break;if(teams.size!==1)continue;const teamId=[...teams][0];if(repoCount.get(teamId)!==1){delete this.supplements.merges![teamId];this.supplements.sources![`merges:${teamId}`]='Multiple repositories; aggregate unavailable';continue;}if(!this.due(`merges:${repo}`,300000))continue;mergeReads++;
    const text=await run('gh',['pr','list','--repo',repo,'--state','merged','--limit','100','--json','number,mergedAt'],5000);
    try{const list=JSON.parse(text??'null');if(!Array.isArray(list))throw Error('missing merges');const days=new Map<string,number>();for(let i=6;i>=0;i--)days.set(new Date(raw.at-i*86400000).toISOString().slice(0,10),0);for(const pr of list){const day=typeof pr.mergedAt==='string'?pr.mergedAt.slice(0,10):'';if(days.has(day))days.set(day,days.get(day)!+1);}this.supplements.merges![teamId]=[...days].map(([day,count])=>({day,count}));this.supplements.sources![`merges:${teamId}`]=`${list.length===100?'Lower bounds · latest 100 PRs':'All '+list.length+' merged PRs'} · ${repo}`;}catch{this.supplements.sources![`merges:${teamId}`]='unavailable (last known merges)';}
   }
   // Keep enrichment bounded as tasks leave the active window.
   const live=new Set(all.map(r=>r.id));for(const id of Object.keys(this.supplements.details!))if(!live.has(id)&&id!==this.selected.taskId)delete this.supplements.details![id];
   if(this.attempts.size>2000)this.attempts.clear();
   this.publish();
  }catch{this.supplements.sources!.enrichment='unavailable';this.publish();}finally{this.enriching=false;if(this.again&&!this.stopped){this.again=false;void this.enrich(true);}}
 }
}
