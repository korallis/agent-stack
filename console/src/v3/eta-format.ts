import type {EtaEstimate} from './eta.ts';
const day=(value:string):string|null=>{const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(date).replace(',',''):null;};
/** Calendar dates, never a time-of-day that looks like a firm deadline. */
export function etaText(estimate?:EtaEstimate,legacy:string|null=null):string {
 if(estimate){if(estimate.remaining===0)return 'Complete';const date=estimate.date&&day(estimate.date);return date?`ETA ~${date}`:estimate.reason??'Completion history unavailable';}
 return legacy&&day(legacy)?`ETA ~${day(legacy)}`:'Completion dates not recorded';
}
export function etaPace(estimate?:EtaEstimate,compact=false):string {
 if(!estimate||!estimate.date)return '';
 if(compact)return `${estimate.completions} ${estimate.unit}/${estimate.windowDays}d · ${estimate.remaining} left`;
 const range=estimate.earliest&&estimate.latest&&estimate.earliest!==estimate.latest?` · range ${day(estimate.earliest)}–${day(estimate.latest)}`:'';
 return `from last ${estimate.windowDays} days' pace · ${estimate.completions} ${estimate.unit} dated, ${estimate.remaining} left${range}`;
}
export function etaDetail(estimate?:EtaEstimate):string {
 if(!estimate)return '';
 return [estimate.scope,etaPace(estimate),estimate.date?'estimate, not a promise · Mon–Fri UTC':'',estimate.source].filter(Boolean).join(' · ');
}
