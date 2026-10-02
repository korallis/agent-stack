/** Presentation-only cleanup. Detail records retain their original authored text. */
export function cardText(value:string|null|undefined,identities:string[]=[]):string {
  let text=(value??'').replace(/\s+/g,' ').trim();
  for(let pass=0;pass<5;pass++){
    const before=text;
    text=text.replace(/^Mission\s*[:—–]\s*/i,'');
    for(const id of identities){
      const literal=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      if(literal)text=text.replace(new RegExp(`^(?:Mission\\s+)?(?:\\[${literal}\\]|${literal})(?:\\s*[:—–|]\\s*|\\s+-\\s+)`,'i'),'');
    }
    text=text.replace(/^(?:queue\s+row|queue\s+item|row|handoff)(?::\s*|\s+[—–-]\s*|\s+(?=qitem-))/i,'')
      .replace(/^\[?(?:WO\d+|T\d{3,}|F-\d+)\]?(?:\s*[:—–]\s*|\s+-\s+)/,'')
      .replace(/^WO\d+\s+(?=\S)/,'')
      .replace(/\bqitem-\d{8,14}-[a-z0-9]{6,}\b/gi,'')
      .replace(/^\s*[:—–|]+\s*/,'').replace(/\s+/g,' ').trim();
    if(text===before)break;
  }
  return text;
}
export function providerName(provider:string):string {
  const names:Record<string,string>={claude:'Claude',anthropic:'Anthropic',codex:'Codex',openai:'OpenAI',xai:'Grok',grok:'Grok','kimi-ai':'Kimi',kimi:'Kimi'};
  const key=provider.toLowerCase();return Object.hasOwn(names,key)?names[key]:provider;
}
