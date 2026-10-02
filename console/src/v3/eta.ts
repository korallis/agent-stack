/** Forecasts use recorded completions in the same inventory as the displayed progress. */
import type {Run} from './sources.ts';
export interface EtaEstimate {date:string|null;earliest:string|null;latest:string|null;remaining:number|null;completions:number;unit:'slices'|'features';windowDays:number;scope:string;reason:string|null;source:string;workingDays:number;rate:number|null}
export interface EtaUnit {id:string;done:boolean;completedAt?:string|null}
export interface FeatureRecord {id:string;passes:boolean}
const DAY=86400000, date=(at:number)=>new Date(at).toISOString().slice(0,10), midnight=(at:number)=>Math.floor(at/DAY)*DAY;
const weekday=(at:number)=>{const d=new Date(at).getUTCDay();return d!==0&&d!==6;};
/** UTC Monday–Friday calendar only; public holidays are not modeled. */
export function addWorkingDays(now:number,days:number):string|null {
 if(!Number.isFinite(now)||!Number.isFinite(days)||days<0||days>26000)return null;
 let at=midnight(now),left=Math.ceil(days);while(left){at+=DAY;if(weekday(at))left--;}
 return date(at);
}
function timestamp(value:string|null|undefined):number|null {
 if(!value||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return null;
 const [year,month,day]=value.slice(0,10).split('-').map(Number);
 if(date(Date.UTC(year,month-1,day))!==value.slice(0,10))return null;
 const at=Date.parse(value);if(!Number.isFinite(at))return null;
 // Date.parse normalizes invalid calendar dates such as February 30.
 if(!value.includes('T')&&date(at)!==value)return null;
 return at;
}
export function estimateEta(input:{units:EtaUnit[];unit:'slices'|'features';scope:string;source:string;now:number;windowDays?:number;valid?:boolean;reason?:string|null}):EtaEstimate {
 const {units,unit,scope,source,now}=input,windowDays=input.windowDays??14;
 const validWindow=Number.isFinite(now)&&Number.isInteger(windowDays)&&windowDays>=7&&windowDays<=14;
 const start=validWindow?midnight(now)-(windowDays-1)*DAY:0;
 let workingDays=0;if(validWindow)for(let i=0;i<windowDays;i++)if(weekday(start+i*DAY))workingDays++;
 const base:EtaEstimate={date:null,earliest:null,latest:null,remaining:null,completions:0,unit,windowDays,scope,reason:null,source,workingDays,rate:null};
 if(!validWindow)return {...base,reason:'Observation window unavailable'};
 if(input.valid===false||!units.length||units.some(u=>!u.id||typeof u.done!=='boolean')||new Set(units.map(u=>u.id)).size!==units.length)return {...base,reason:input.reason??'Complete unique inventory unavailable'};
 const remaining=units.filter(u=>!u.done).length;
 const completed=units.filter(u=>u.done).map(u=>timestamp(u.completedAt)).filter((at):at is number=>at!==null&&at>=start&&at<=now);
 const completions=completed.length,rate=completions/workingDays;
 const result={...base,remaining,completions,rate:completions?rate:null};
 if(remaining===0)return {...result,date:date(now),reason:'All recorded units complete'};
 if(completions<3)return {...result,reason:`Too few completed ${unit} to estimate (${completions} of 3 required dated completions in ${windowDays} calendar days)`};
 const projected=addWorkingDays(now,remaining/rate);if(!projected)return {...result,reason:'Forecast exceeds supported working-day horizon'};
 // Empirical daily pace spread, not a confidence interval. Include zero-completion
 // calendar days; normalize their rates so the mean matches the working-day pace.
 const buckets=Array.from({length:windowDays},()=>0);for(const at of completed)buckets[Math.floor((midnight(at)-start)/DAY)]++;
 const rates=buckets.map(n=>n*windowDays/workingDays).sort((a,b)=>a-b);
 const quantile=(p:number)=>{const i=(rates.length-1)*p,lo=Math.floor(i);return rates[lo]+(rates[Math.ceil(i)]-rates[lo])*(i-lo);};
 const slow=quantile(.25),fast=quantile(.75);
 const range=windowDays>=10&&completions>=5&&slow>0&&fast>0;
 return {...result,date:projected,earliest:range?addWorkingDays(now,remaining/Math.max(rate,fast)):null,latest:range?addWorkingDays(now,remaining/Math.min(rate,slow)):null};
}
export function featureUnits(value:unknown):FeatureRecord[]|null {
 const rows=Array.isArray(value)?value:(value as {features?:unknown})?.features;
 if(!Array.isArray(rows)||rows.length>5000||rows.some(f=>!f||typeof f.id!=='string'||!f.id.trim()||typeof f.passes!=='boolean')||new Set(rows.map(f=>f.id)).size!==rows.length)return null;
 return rows.map(f=>({id:f.id,passes:f.passes}));
}
export const FEATURE_HISTORY_LIMIT=64;
/** Pin before calling. Each changed first-parent commit is compared with its actual
 * parent, including the boundary before the observation window. Initial imports
 * are not completions. Any incomplete read invalidates the whole history. */
export async function readFeatureHistory(repo:string,revision:string,current:FeatureRecord[],run:Run,now:number):Promise<{units:EtaUnit[];reason:string|null;source:string}> {
 const source=`Verified first-parent feature transitions at ${revision}; 14 calendar days, normalized to UTC Monday–Friday; no holidays`;
 const empty=current.map(f=>({id:f.id,done:f.passes,completedAt:null})),unavailable=(reason='Feature completion history unavailable')=>({units:empty,reason,source});
 if(!/^[0-9a-f]{40,64}$/i.test(revision)||!featureUnits(current))return unavailable();
 const started=Date.now();let calls=0,bytes=0;
 const read=async(args:string[])=>{if(++calls>260||Date.now()-started>10000)return null;const text=await run('git',['-C',repo,...args],3000);if(text===null||Date.now()-started>10000||Buffer.byteLength(text)>512*1024)return null;bytes+=Buffer.byteLength(text);return bytes>8*1024*1024?null:text;};
 const start=midnight(now)-13*DAY;
 const log=await read(['log','--first-parent',`--since-as-filter=${new Date(start).toISOString()}`,`--max-count=${FEATURE_HISTORY_LIMIT+1}`,'--format=%H %ct %P',revision,'--','features.json']);
 if(log===null)return unavailable();const lines=log.trim()?log.trim().split('\n'):[];
 if(lines.length>FEATURE_HISTORY_LIMIT)return unavailable('Feature history read limit reached');
 const cache=new Map<string,FeatureRecord[]>([[revision,current]]);
 const snapshot=async(sha:string):Promise<FeatureRecord[]|null>=>{
  if(cache.has(sha))return cache.get(sha)!;
  const text=await read(['show',`${sha}:features.json`]);
  if(text===null){const tree=await read(['ls-tree',sha,'--','features.json']);if(tree!==null&&!tree.trim()){cache.set(sha,[]);return [];}return null;}
  try{const rows=featureUnits(JSON.parse(text));if(rows)cache.set(sha,rows);return rows;}catch{return null;}
 };
 const seen=new Set<string>(),completed=new Map<string,string>(),passing=new Set(current.filter(f=>f.passes).map(f=>f.id));
 for(const line of lines){
  const fields=line.trim().split(/\s+/),[sha,seconds,...parents]=fields;
  if(!/^[0-9a-f]{40,64}$/i.test(sha)||!/^\d+$/.test(seconds)||parents.some(p=>!/^[0-9a-f]{40,64}$/i.test(p)))return unavailable();
  const after=await snapshot(sha),before=parents.length?await snapshot(parents[0]):[];if(!after||!before)return unavailable();
  const previous=new Map(before.map(f=>[f.id,f.passes]));
  for(const f of after){if(!passing.has(f.id)||seen.has(f.id)||!f.passes)continue;
   // Remember the newest introduction or transition, even when outside the
   // observation window, so a reintroduced ID cannot inherit an older completion.
   if(previous.get(f.id)===true)continue;seen.add(f.id);
   const at=Number(seconds)*1000;if(previous.get(f.id)===false&&at>=start&&at<=now)completed.set(f.id,new Date(at).toISOString());
  }
 }
 return {units:empty.map(u=>({...u,completedAt:completed.get(u.id)??null})),reason:null,source};
}
