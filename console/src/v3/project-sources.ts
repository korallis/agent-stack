/** Local project scope discovered from authored workspace/rig metadata. No machine-specific names. */
import fs from 'node:fs';
import path from 'node:path';
import {readBounded, type Run} from './sources.ts';
import type {Step} from './types.ts';
export interface ProjectScope {projectId:string;root:string;repo:string|null;name:string;description:string;milestone:string|null;progress:number|null;progressLabel:string;source:string;eta:null;milestones:Step[];activeMissions:{id:string;label:string;status:string}[];nativeAgents?:Record<string,{cwd:string;model:string|null}>}
const scalarValue=(v:string):string|null=>{
 const text=v.trim();if(/^[&*!\[{]/.test(text))return null;
 if(text.startsWith('"')){try{return JSON.parse(text);}catch{return null;}}
 if(text.startsWith("'"))return text.endsWith("'")?text.slice(1,-1).replace(/''/g,"'"):null;
 return text.replace(/\s+#.*$/,'').trim()||null;
};
/** Deliberately a scalar projection, not a general YAML implementation: complex values stay unavailable.
 * The authored manifests use nested block mappings and block sequences; anchors/tags are never evaluated. */
export function manifestScalar(text:string,keys:string[]):string|null {
 const stack:{indent:number;key:string}[]=[];const lines=text.split('\n');
 for(let i=0;i<lines.length;i++){
  const m=lines[i].match(/^( *)([A-Za-z_][\w.-]*):(?:[ \t]*(.*))?$/);if(!m)continue;
  const indent=m[1].length;while(stack.length&&stack.at(-1)!.indent>=indent)stack.pop();
  const address=[...stack.map(s=>s.key),m[2]];const value=(m[3]??'').trim();
  if(address.join('.')===keys.join('.')){
   if(/^[>|][-+]?/.test(value)){const parts:string[]=[];for(let j=i+1;j<lines.length&&(!lines[j].trim()||lines[j].search(/\S/)>indent);j++)parts.push(lines[j].trim());return parts.join(' ').trim()||null;}
   return scalarValue(value);
  }
  if(!value||value.startsWith('#'))stack.push({indent,key:m[2]});
 }
 return null;
}
function members(text:string):{refs:string[];valid:boolean} {
 const lines=text.split('\n'),start=lines.findIndex(l=>/^\s+slices:\s*(?:#.*)?$/.test(l));
 if(start<0)return {refs:[],valid:/^\s+slices:\s*\[\s*\]\s*(?:#.*)?$/m.test(text)};
 const invalid=()=>({refs:[],valid:false});
 const base=lines[start].search(/\S/),refs:{ref:string|null;active:boolean;seen:Set<string>}[]=[];let itemIndent:number|null=null;
 for(const line of lines.slice(start+1)){
  if(!line.trim()||line.trim().startsWith('#'))continue;const indent=line.search(/\S/);if(indent<base||indent===base&&!line.trimStart().startsWith('-'))break;
  // Interpret the complete bounded block-list grammar or reject it. Ignoring
  // a flow mapping, alias or unknown field would silently shrink the denominator.
  if(/\t/.test(line.slice(0,indent)))return invalid();
  const entry=line.match(/^ *- +(.*)$/);let field:string;
  if(entry){
   if(itemIndent===null)itemIndent=indent;
   if(indent!==itemIndent)return invalid();
   refs.push({ref:null,active:true,seen:new Set()});field=entry[1];
  }else{
   if(itemIndent===null||indent!==itemIndent+2)return invalid();
   field=line.trimStart();
  }
  const pair=field.match(/^(ref|active|order):\s*(.+)$/),current=refs.at(-1);
  if(!pair||!current||current.seen.has(pair[1]))return invalid();current.seen.add(pair[1]);
  const value=scalarValue(pair[2]);if(!value)return invalid();
  if(pair[1]==='ref')current.ref=value;
  else if(pair[1]==='active'){if(!/^(true|false)(?:\s+#.*)?$/.test(pair[2].trim()))return invalid();current.active=value==='true';}
  else if(!/^\d+$/.test(value))return invalid();
 }
 if(refs.some(r=>r.ref===null))return invalid();
 return {refs:[...new Set(refs.filter(r=>r.active).map(r=>r.ref!))],valid:true};
}
function inside(root:string,ref:string):string|null {
 if(path.isAbsolute(ref))return null;const resolved=path.resolve(root,ref),relative=path.relative(root,resolved);
 if(relative.startsWith('..')||path.isAbsolute(relative))return null;
 try{const real=fs.realpathSync(resolved),rel=path.relative(fs.realpathSync(root),real);return rel.startsWith('..')||path.isAbsolute(rel)?null:real;}catch{return null;}
}
const heading=(text:string)=>text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').match(/^#\s+(.+)$/m)?.[1]?.trim()??null;
const frontmatter=(text:string)=>text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]??'';
const listDirs=(dir:string,limit:number)=>{try{return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).slice(0,limit).map(e=>e.name).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));}catch{return [];}};
function authoredPurpose(project:string,spec:string,culture:string,readme:string):string {
 const explicit=manifestScalar(project,['metadata','description'])??manifestScalar(project,['metadata','purpose'])??manifestScalar(project,['description']);if(explicit)return explicit.slice(0,180);
 const intentSection=culture.match(/^##\s+(?:Purpose|Intent|Mission)\s*\n+([^#][\s\S]*?)(?=\n\n|\n##|$)/im)?.[1]?.trim();if(intentSection)return intentSection.replace(/\s+/g,' ').slice(0,180);
 const specifics=culture.match(/^##[^\n]* specifics\n([\s\S]*?)(?=\n##|$)/im)?.[1]?.replace(/\s+/g,' ');
 const purpose=specifics?.match(/^- Repo:.*?\)\.\s*(.+?)(?:\s+Binding rules:| - |$)/)?.[1];if(purpose)return purpose.slice(0,180);
 const readmeTitle=heading(readme);if(readmeTitle?.includes(' — '))return readmeTitle.split(' — ').slice(1).join(' — ').slice(0,180);
 const intent=manifestScalar(frontmatter(spec),['intent']);return intent&&!/Organize this project's durable work/.test(intent)?intent.replace(/\s+/g,' ').slice(0,180):'Project purpose not available.';
}
export async function readProjectScopes(projectsRoot:string,rigNames:string[],run:Run):Promise<Record<string,ProjectScope>> {
 const out:Record<string,ProjectScope>={};let reads=0;
 const read=(file:string)=>++reads<=2400?readBounded(file,256<<10)??'':'';
 for(const directory of listDirs(projectsRoot,200).filter(n=>n.endsWith('-work'))){
  const root=path.join(projectsRoot,directory),project=read(path.join(root,'project.yaml'));const projectId=manifestScalar(project,['metadata','id']);if(!projectId)continue;
  const bindings:{rig:string;repo:string|null}[]=[];const rigDir=path.join(root,'rig');
  let rigFiles:string[]=[];try{rigFiles=fs.readdirSync(rigDir).filter(n=>n.endsWith('.yaml')).slice(0,20);}catch{}
  for(const file of rigFiles){const text=read(path.join(rigDir,file)),rig=manifestScalar(text,['name']);if(rig&&rigNames.includes(rig)&&!bindings.some(b=>b.rig===rig)){const repo=manifestScalar(text,['workspace','workspace_root']);bindings.push({rig,repo:repo?path.resolve(root,'rig',repo):null});}}
  if(!bindings.length)continue;
  const spec=read(path.join(root,'SPEC.md')),culture=read(path.join(root,'rig','CULTURE.md')),base=directory.slice(0,-5);
  const name=manifestScalar(project,['metadata','name'])??manifestScalar(project,['metadata','displayName'])??base;
  const repo=bindings[0].repo;const readme=repo?read(path.join(repo,'README.md')):'';
  const description=authoredPurpose(project,spec,culture,readme);
  const missionsRef=manifestScalar(project,['missions','root'])??'missions',missionsRoot=inside(root,missionsRef);if(!missionsRoot)continue;
  const missions=listDirs(missionsRoot,80).map(id=>{const dir=path.join(missionsRoot,id),text=read(path.join(dir,'mission.yaml')),status=manifestScalar(text,['metadata','status'])??'unknown';return {id,dir,text,status,label:heading(read(path.join(dir,'SPEC.md')))??manifestScalar(text,['metadata','name'])??id};});
  const building=missions.filter(m=>m.status==='building');const active=building.length?building:missions.filter(m=>m.status==='active'||m.status==='in-progress');
  const activeMissions=active.map(({id,label,status})=>({id,label,status}));let total=0,done=0,unknown=0,valid=active.length>0;
  const milestones:Step[]=[];
  for(const m of active){const membership=members(m.text);if(!membership.valid)valid=false;
   for(const ref of membership.refs){const file=inside(m.dir,ref);if(!file){valid=false;continue;}total++;
    const slice=read(file),sliceDir=path.dirname(file),specRef=manifestScalar(slice,['composition','slice_markdown','spec'])??'SPEC.md',specFile=inside(sliceDir,specRef),sliceSpec=specFile?read(specFile):'';
    const state=manifestScalar(slice,['metadata','status'])??manifestScalar(frontmatter(sliceSpec),['status']);if(state==='done')done++;if(!state)unknown++;
    const id=manifestScalar(slice,['metadata','id'])??path.basename(sliceDir);
    milestones.push({id:`${m.id}/${id}`,label:heading(sliceSpec)??id,state:state==='done'?'done':['building','in-progress','review','in-review'].includes(state??'')?'active':state?'waiting':'unknown',at:null,detail:`${m.label} · authored status: ${state??'unknown'}`});
   }
  }
  let progress=valid&&total?Math.round(done/total*100):null;
  let source=`Local mission and slice manifests read ${new Date().toISOString()}`;
  let progressLabel=valid&&total?`${done}/${total} slices marked done${unknown?` · ${unknown} statuses unknown`:''} · ${active.length>1?'active missions':'active mission'}`:'Slice progress unavailable';
  if(repo){const text=await run('git',['-C',repo,'show','origin/main:features.json'],4000);try{const value=JSON.parse(text??'null'),features=Array.isArray(value)?value:value?.features;if(Array.isArray(features)&&features.length&&features.every(f=>f&&typeof f.passes==='boolean')){const passing=features.filter(f=>f.passes).length;progress=Math.round(passing/features.length*100);progressLabel=`${passing}/${features.length} project features pass · origin/main`;const revision=(await run('git',['-C',repo,'rev-parse','origin/main'],3000))?.trim();source=`Local origin/main${revision&&/^[0-9a-f]{40,64}$/i.test(revision)?'@'+revision:''}; remote freshness unknown; read ${new Date().toISOString()}`;}}catch{}}
  const milestone=active.length===1?active[0].label:active.length?`${active.slice(0,3).map(m=>m.label).join(' · ')}${active.length>3?` +${active.length-3} active`:''}`:null;
  for(const binding of bindings){
   const nativeAgents:Record<string,{cwd:string;model:string|null}>={};let files:string[]=[];try{files=fs.readdirSync(path.join(rigDir,'native')).filter(n=>n.endsWith('.yaml')).slice(0,100);}catch{}
   for(const file of files){const text=read(path.join(rigDir,'native',file));if(manifestScalar(text,['runtime'])!=='terminal')continue;
    const launch=text.match(/^\s+value:\s*["']?agent-native-seat\s+(grok|kimi)\b([^\n]*)/m),cwd=manifestScalar(text,['cwd']);
    if(!launch||!cwd||!path.isAbsolute(cwd))continue;const model=launch[2].match(/--model(?:=|\s+)([^\s"']+)/)?.[1]??null;
    nativeAgents[`${file.slice(0,-5)}@${binding.rig}`]={cwd,model};
   }
   out[binding.rig]={projectId,root,repo:binding.repo,name,description,milestone,progress,progressLabel,source,eta:null,milestones,activeMissions,nativeAgents};
  }
 }
 return out;
}
