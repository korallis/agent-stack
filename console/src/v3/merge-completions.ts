import {DatabaseSync} from 'node:sqlite';
import type {Run} from './sources.ts';

export const MERGE_COMPLETION_SOURCE='latest mapped merged PR';
export const completionKey=(projectId:string,missionId:string,sliceId:string)=>`${projectId}/${missionId}/${sliceId}`;

export interface CompletionUnit {
 done?:boolean;
 projectId?:string;
 missionId:string;
 missionDirectory?:string;
 missionAliases?:string[];
 sliceId:string;
 sliceDirectory?:string;
 sliceAliases?:string[];
}
export interface MergeProject {projectId:string;repo:string;units?:CompletionUnit[]}
export interface MergeCompletion {at:string;source:string;pr:number;url:string}
export interface MergeCompletionResult {
 evidence:Record<string,MergeCompletion>;
 unavailableProjects:Record<string,string>;
 queries:Record<string,{repo:string;returned:number;complete:boolean}>;
}
interface Pull {number:unknown;mergedAt:unknown;url?:unknown}

const iso=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function validAt(value:unknown,now:number,start:number):string|null {
 if(typeof value!=='string')return null;const m=value.match(iso);if(!m)return null;
 const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);if(Number(m[4])>23||Number(m[5])>59||Number(m[6])>59)return null;const check=new Date(Date.UTC(y,mo-1,d));
 if(check.getUTCFullYear()!==y||check.getUTCMonth()+1!==mo||check.getUTCDate()!==d)return null;
 const at=Date.parse(value);if(!Number.isFinite(at)||at<start||at>now)return null;
 return new Date(at).toISOString();
}
function repoName(remote:string|null):string|null {
 if(!remote)return null;let s=remote.trim().replace(/\.git$/i,'');
 const m=s.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)(?:github\.com[/:])([^/\s]+\/[^/\s]+)$/i);
 return m?m[1].toLowerCase():null;
}
function repoUrl(value:unknown):string|null {
 if(typeof value!=='string')return null;const m=value.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
 return m?`${m[1].toLowerCase()}#${m[2]}`:null;
}
function tagValues(tags:string[],prefix:string):string[] {return [...new Set(tags.filter(t=>t.startsWith(prefix)).map(t=>t.slice(prefix.length)).filter(Boolean))];}
function prNumbers(tags:string[],text:string,expectedRepo:string):{numbers:number[];invalid:boolean} {
 const nums=new Set<number>();let invalid=false;
 for(const t of tags){const m=t.match(/^pr[:-](\d+)$/i);if(m)nums.add(Number(m[1]));}
 const urlPattern=/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/?#][^\s)]*)?/gi;
 for(const raw of text.match(urlPattern)??[]){const r=repoUrl(raw);if(!r){invalid=true;continue;}const [repo,n]=r.split('#');if(repo!==expectedRepo)invalid=true;else nums.add(Number(n));}
 return {numbers:[...nums].filter(n=>Number.isSafeInteger(n)&&n>0),invalid:invalid||nums.size!==1};
}
function aliasMap(project:MergeProject):Map<string,CompletionUnit[]> {
 const out=new Map<string,CompletionUnit[]>();for(const u of project.units??[]){for(const a of new Set([u.missionId,u.missionDirectory,...(u.missionAliases??[])])){if(!a)continue;const list=out.get(`m:${a}`)??[];list.push(u);out.set(`m:${a}`,list);}for(const a of new Set([u.sliceId,u.sliceDirectory,...(u.sliceAliases??[])])){if(!a)continue;const list=out.get(`s:${a}`)??[];list.push(u);out.set(`s:${a}`,list);}}return out;
}
function resolveUnit(project:MergeProject,aliases:Map<string,CompletionUnit[]>,mission:string,slice:string):CompletionUnit|null {
 if(!project.units)return {projectId:project.projectId,missionId:mission,sliceId:slice};
 const mm=aliases.get(`m:${mission}`)??[],ss=aliases.get(`s:${slice}`)??[];
 const candidates=mm.filter(m=>ss.includes(m));return candidates.length===1?candidates[0]:null;
}

/** Read queue evidence and one bounded GitHub merged-PR listing per project.
 * Queue states/closures are deliberately ignored: current slice status remains
 * the caller's authority. A returned timestamp is the latest mapped PR merge,
 * an approximation rather than proof of the acceptance decision. */
export async function collectMergeCompletions(input:{dbPath:string;projects:MergeProject[];run:Run;now:number;windowDays?:number;maxPulls?:number}):Promise<MergeCompletionResult> {
 const maxPulls=Math.min(500,input.maxPulls??500),windowDays=input.windowDays??14,start=Math.floor(input.now/86400000)*86400000-(windowDays-1)*86400000;
 const result:MergeCompletionResult={evidence:{},unavailableProjects:{},queries:{}};
 if(!Number.isFinite(input.now)||!Number.isInteger(maxPulls)||maxPulls<1||windowDays!==14)return result;
 let db:DatabaseSync;try{db=new DatabaseSync(input.dbPath,{readOnly:true});}catch(e){for(const p of input.projects)result.unavailableProjects[p.projectId]=`queue database unavailable: ${(e as Error).message}`;return result;}
 try {
  for(const project of input.projects){
   if(project.units&&(!project.units.length||project.units.every(u=>u.done===false)))continue;
   let rows:Array<{tags:string|null;body:string|null;evidence_ref:string|null;oversize:number}>;
   try {
    const size=db.prepare(`SELECT count(*) AS count, sum(coalesce(length(CAST(tags AS BLOB)),0)+coalesce(length(CAST(body AS BLOB)),0)+coalesce(length(CAST(evidence_ref AS BLOB)),0)) AS bytes FROM
      (SELECT tags,body,evidence_ref FROM queue_items WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END) WHERE value=?) LIMIT 10001)`).get(`project:${project.projectId}`) as {count:number;bytes:number|null};
    if(size.count>10000||(size.bytes??0)>16*1024*1024){result.unavailableProjects[project.projectId]='queue evidence read limit reached';continue;}
    rows=db.prepare(`SELECT substr(tags,1,32768) AS tags, substr(body,1,65536) AS body, substr(evidence_ref,1,4096) AS evidence_ref,
      (length(CAST(tags AS BLOB))>32768 OR length(CAST(body AS BLOB))>65536 OR length(CAST(evidence_ref AS BLOB))>4096) AS oversize
      FROM queue_items WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END) WHERE value=?) LIMIT 10001`).all(`project:${project.projectId}`) as typeof rows;
   }catch{result.unavailableProjects[project.projectId]='queue schema unavailable';continue;}
   if(rows.length>10000||rows.some(r=>r.oversize)||rows.reduce((sum,r)=>sum+Buffer.byteLength(r.tags??'')+Buffer.byteLength(r.body??'')+Buffer.byteLength(r.evidence_ref??''),0)>16*1024*1024){result.unavailableProjects[project.projectId]='queue evidence read limit reached';continue;}
   if(!rows.length)continue;
   let remote:string|null;try{remote=repoName(await input.run('git',['-C',project.repo,'config','--get','remote.origin.url'],3000));}catch{remote=null;}
   if(!remote){result.unavailableProjects[project.projectId]='GitHub origin remote unavailable or unsupported';continue;}
   let raw:string|null;try{raw=await input.run('gh',['pr','list','--repo',remote,'--state','merged','--search',`merged:>=${new Date(start).toISOString().slice(0,10)}`,'--limit',String(maxPulls+1),'--json','number,mergedAt,url'],5000);}catch{raw=null;}
   if(raw===null||Buffer.byteLength(raw)>1024*1024){result.unavailableProjects[project.projectId]='GitHub merged-PR query failed or response too large';continue;}
   let pulls:Pull[];try{const parsed=JSON.parse(raw);if(!Array.isArray(parsed))throw new Error('not an array');pulls=parsed;}catch{result.unavailableProjects[project.projectId]='GitHub merged-PR response invalid';continue;}
   result.queries[project.projectId]={repo:remote,returned:pulls.length,complete:pulls.length<=maxPulls};
   if(pulls.length>maxPulls){result.unavailableProjects[project.projectId]=`GitHub result cap exceeded (${maxPulls})`;continue;}
   const byNumber=new Map<number,Pull>();let invalidPulls=false;for(const pr of pulls){if(!pr||typeof pr.number!=='number'||!Number.isSafeInteger(pr.number)||pr.number<1||byNumber.has(pr.number)){invalidPulls=true;break;}byNumber.set(pr.number,pr);}
   if(invalidPulls){result.unavailableProjects[project.projectId]='GitHub merged-PR identities invalid or duplicated';continue;}
   const candidates=new Map<string,Map<number,string>>();const aliases=aliasMap(project);
   for(const row of rows){let tags:string[];try{const value=JSON.parse(row.tags??'[]');if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))continue;tags=value;}catch{continue;}
    const ps=tagValues(tags,'project:');if(ps.length!==1||ps[0]!==project.projectId)continue;const ms=tagValues(tags,'mission:'),ss=tagValues(tags,'slice:');if(ms.length!==1||ss.length!==1||tagValues(tags,'candidate:').length>1)continue;
    const unit=resolveUnit(project,aliases,ms[0],ss[0]);if(!unit||unit.done===false)continue;const text=`${row.body??''} ${row.evidence_ref??''}`;const numbers=prNumbers(tags,text,remote);if(numbers.invalid||!numbers.numbers.length)continue;
    const key=completionKey(project.projectId,unit.missionId,unit.sliceId),mapped=candidates.get(key)??new Map<number,string>();for(const n of numbers.numbers){const pr=byNumber.get(n),url=repoUrl(pr?.url);if(!pr||url!==`${remote}#${n}`)continue;const at=validAt(pr.mergedAt,input.now,start);if(at)mapped.set(n,at);}candidates.set(key,mapped);
   }
   for(const [key,mapped] of candidates){let best:{pr:number;at:string}|null=null;for(const [pr,at] of mapped)if(!best||at>best.at)best={pr,at};if(best){const url=`https://github.com/${remote}/pull/${best.pr}`;result.evidence[key]={at:best.at,source:MERGE_COMPLETION_SOURCE,pr:best.pr,url};}}
  }
 } finally {db.close();}
 return result;
}
