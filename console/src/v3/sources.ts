/** Bounded, read-only enrichment. No command here changes queue, proof or repository state. */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { PullRequest, Step, Team } from './types.ts';
export const MAX_BYTES = 4 << 20;
export type Run = (command:string,args:string[],timeout:number)=>Promise<string|null>;
export const runRead:Run = (command,args,timeout) => new Promise(resolve => {
  execFile(command,args,{timeout,maxBuffer:MAX_BYTES},(error,out)=>resolve(error ? null : out));
});
export function readBounded(file:string,max=MAX_BYTES,tail=false):string|null {
  let fd:number|undefined;
  try {const size=fs.statSync(file).size;if(size>max&&!tail)return null;fd=fs.openSync(file,'r');const n=Math.min(size,max),b=Buffer.alloc(n);const read=fs.readSync(fd,b,0,n,size-n);let text=b.subarray(0,read).toString('utf8');if(size>max)text=text.slice(text.indexOf('\n')+1);return text;}catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export async function getJson(url:string,signal:AbortSignal,limit=MAX_BYTES):Promise<any> {
 const res=await fetch(url,{signal});if(!res.ok||!res.body)throw Error(`HTTP ${res.status}`);
 const reader=res.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('response exceeds read limit');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}
}
export function prIdentity(value:unknown):{repo:string;number:number;url:string}|null {
 if(typeof value!=='string')return null;
 const m=value.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
 if(!m||Number(m[2])<=0)return null;return {repo:m[1].toLowerCase(),number:Number(m[2]),url:`https://github.com/${m[1]}/pull/${Number(m[2])}`};
}
export function repoName(value:unknown):string|null {
 if(typeof value!=='string')return null;
 const m=value.match(/^(?:https:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/);return m?.[1]??null;
}
const num=(n:any)=>typeof n==='number'&&Number.isFinite(n)?n:null;
const gateStatus=(p:any)=>p.headRefOid?(p.statusCheckRollup??[]).filter((c:any)=>c.context==='jev-merge').sort((a:any,b:any)=>String(b.createdAt??'').localeCompare(String(a.createdAt??'')))[0]:null;
export const gateTargetFromGithub=(p:any):string|null=>{const gate=gateStatus(p);return typeof gate?.targetUrl==='string'?gate.targetUrl:null;};
export function prFromGithub(p:any,teamId:string|null=null):PullRequest {
 const checks:Step[]=(p.statusCheckRollup??[]).map((c:any,i:number)=>({id:`check-${i}`,label:c.name??c.context??'Check',state:['SUCCESS','NEUTRAL','SKIPPED'].includes(c.conclusion??c.state)?'done':['FAILURE','ERROR','TIMED_OUT','CANCELLED','ACTION_REQUIRED'].includes(c.conclusion??c.state)?'blocked':'waiting',at:c.completedAt??c.startedAt??null,detail:c.conclusion??c.status??c.state??'Unknown'}));
 const reviews:Step[]=(p.reviews??[]).map((r:any,i:number)=>({id:`review-${i}`,label:r.author?.login??'Reviewer',state:r.state==='APPROVED'?'done':r.state==='CHANGES_REQUESTED'?'blocked':'waiting',at:r.submittedAt??null,detail:r.state??'Unknown'}));
 const gate=gateStatus(p);
 const verdict:PullRequest['verdict']=!gate?'UNKNOWN':gate.state==='SUCCESS'?'ACT':['FAILURE','ERROR'].includes(gate.state)?'HOLD':'WAIT';
 return {id:p.url,teamId,title:p.title??`PR #${p.number}`,url:p.url,number:p.number,state:p.state??'UNKNOWN',additions:num(p.additions),deletions:num(p.deletions),files:Array.isArray(p.files)?p.files.length:null,checks,reviews,verdict,band:null,reason:gate?`jev-merge on head ${p.headRefOid}${gate.description?`: ${gate.description}`:''}`:null,signals:[],at:p.updatedAt??null};
}
/** Logs with only a caller or state hash have no PR identity and cannot authorize a verdict. */
export function bindVerdict(pr:PullRequest,records:any[],head:string|null,target:string|null=null):PullRequest {
 if(pr.verdict==='UNKNOWN')return {...pr,reason:'No current-head jev-merge status; historical or unbound logs are not a verdict'};
 if(!head||!target)return pr;
 const identity=prIdentity(pr.url);if(!identity)return pr;
 const matching=records.filter(r=>{
  if((r.targetUrl??r.target_url??r.action?.targetUrl??r.input?.targetUrl)!==target)return false;
  if(r.decision!=='review.merge_gate'||/(^|\s)diagnosis(:|\s|$)/.test(r.caller??''))return false;
  const p=r.pr??r.input?.pr??r.action?.pr;
  const id=prIdentity(typeof p==='string'?p:p?.url);
  const repo=id?.repo??repoName(p?.repo??r.input?.repo)?.toLowerCase();const number=id?.number??p?.number;
  const boundHead=p?.head??p?.headRefOid??r.input?.headRefOid;
  return repo===identity.repo&&number===identity.number&&typeof boundHead==='string'&&!!head&&boundHead===head;
 }).sort((a,b)=>String(b.ts).localeCompare(String(a.ts)));
 const r=matching[0];if(!r)return pr;
 const signals=r.jev_signals??r.signals??{};
 return {...pr,band:r.band??null,signals:Object.entries(signals).slice(0,20).map(([name,value])=>({name,value:typeof value==='string'?value:JSON.stringify(value)}))};
}
export type Progress = Pick<Team,'milestone'|'progress'|'eta'|'milestones'>;
/** Only the daemon's attributed proof readiness is acceptance; checkboxes and done rows are not. */
export function progressFromExecution(e:any):Progress {
 const empty:Progress={milestone:null,progress:null,eta:null,milestones:[]};
 if(!e||e.mission==='INDETERMINATE'||typeof e.mission!=='string')return empty;
 const authored=Array.isArray(e.q2_sequencing)?e.q2_sequencing:[];
 if(!authored.length||!e.sources?.arrangement?.manifest||e.sources.arrangement.value==='INDETERMINATE')return {...empty,milestone:e.mission};
 const proof=new Map((e.readiness?.slices??[]).map((s:any)=>[s.id??s.scope,s.readiness]));
 let complete=true,done=0;
 const milestones:Step[]=authored.map((s:any)=>{
  const p:any=proof.get(s.dir)??proof.get(s.slice_id);const known=p?.configured===true&&['ready','not-ready'].includes(p.state);
  if(!known)complete=false;const accepted=known&&p.state==='ready';if(accepted)done++;
  return {id:s.slice_id??s.dir,label:s.slice_id??s.dir,state:accepted?'done':known?'waiting':'unknown',at:null,detail:accepted?'Accepted proof is ready':known?'Proof not ready':'Proof readiness unknown'};
 });
 return {milestone:e.mission,progress:complete?Math.round(done/authored.length*100):null,eta:null,milestones};
}

/** Preserve authored criteria; a proof reference is evidence, not an acceptance criterion. */
export function acceptanceFromBody(body:string|null|undefined):string|null {
 if(!body)return null;
 const lines=body.split('\n');let begin=-1;
 for(let i=0;i<lines.length;i++){
  const heading=lines[i].match(/^#{1,6}\s+(?:acceptance(?: criteria)?|done when|definition of done)\s*:?[ \t]*$/i);
  if(heading){begin=i+1;break;}
  const inline=lines[i].match(/^(?:acceptance(?: criteria)?|done when|definition of done):[ \t]*(.+)$/i);
  if(inline)return inline[1].trim().slice(0,4000);
 }
 if(begin<0)return null;let end=begin;while(end<lines.length&&!/^#{1,6}\s/.test(lines[end]))end++;
 return lines.slice(begin,end).join('\n').trim().slice(0,4000)||null;
}
