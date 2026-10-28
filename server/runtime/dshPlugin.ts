/** Observer for the installed DSH Session event contract. Never sends input or grants permissions. */
export const DSH_PLUGIN = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const name = 'vade-dsh-observer';
// The native header cwd is immutable. Materialize a separate native log through
// the installed persistence API before the TUI reads its preset/route or resumes.
export function installContinuation(ctx, config) {
  const { continuation: source, expected, cwd, continuationReceipt: receipt } = config;
  if (!source) return;
  const valid = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id);
  if (!valid(source.threadId) || !valid(expected) || source.threadId === expected || !path.isAbsolute(source.cwd) || !path.isAbsolute(cwd) || !path.isAbsolute(receipt)) throw new Error('Invalid DSH continuation binding');
  const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  ctx.inject(['sessionPersistence'], child => {
    const persistence = child.get('sessionPersistence'), original = persistence.open;
    let pending;
    const identity = { source: source.threadId, sourceCwd: source.cwd, target: expected, cwd, ...(source.beforeSeq!==undefined?{beforeSeq:source.beforeSeq,beforeMessageId:source.beforeMessageId}:{}) };
    const save = complete => { const temp=receipt+'.tmp';fs.writeFileSync(temp,JSON.stringify({...identity,complete}),{mode:0o600});fs.renameSync(temp,receipt); };
    const materialize = async options => {
      if (fs.existsSync(receipt)) {
        if(fs.statSync(receipt).size>4096)throw new Error('Invalid DSH continuation receipt');
        const stamp=JSON.parse(fs.readFileSync(receipt,'utf8'));
        if (!stamp.complete || Object.keys(identity).some(k=>stamp[k]!==identity[k])) throw new Error('DSH continuation delivery is uncertain; inspect Terminal before retrying');
        return;
      }
      // No fallback on corrupt/unreadable destination logs, and no overwrite.
      let existing;
      try { existing=await original.call(persistence,expected,'read',options); }
      catch(error) { if(error?.name!=='SessionPersistenceNotFoundError'||error.sessionId!==expected)throw error; }
      if(existing){await existing.close();throw new Error('DSH continuation destination already exists without a completion receipt');}
      let input, output;
      try {
        // Hold the native single-writer lease while taking the snapshot, so a
        // session mounted outside Vade is refused too. Never append to source.
        input=await original.call(persistence,source.threadId,'write',options);
        const header=input.header;
        if(header.id!==source.threadId || typeof header.cwd!=='string' || norm(header.cwd)!==norm(source.cwd) || header.parentSession || header.origin==='subagent')throw new Error('DSH continuation source workspace or identity changed');
        if(source.beforeSeq!==undefined&&(!Number.isSafeInteger(source.beforeSeq)||source.beforeSeq<0||source.beforeSeq>=4000))throw new Error('DSH rewind target exceeds the native continuation limit');
        const page=await input.read(0,source.beforeSeq===undefined?4001:source.beforeSeq+1,options);let events=page.events;
        if(!Array.isArray(events)||events.length>4000||Buffer.byteLength(JSON.stringify(events))>16*1024*1024)throw new Error('DSH session exceeds the native continuation limit; use Hand Off instead');
        if(source.beforeSeq!==undefined){
          const event=events[source.beforeSeq];
          if(!Number.isSafeInteger(source.beforeSeq)||source.beforeSeq<0||event?.seq!==source.beforeSeq||event.type!=='user/message'||event.data?.role!=='user'||event.data?.source?.kind!=='user'||event.data?.id!==source.beforeMessageId)throw new Error('DSH rewind target changed');
          events=events.slice(0,source.beforeSeq);
        }
        // Mark intent before taking a native writer. A failed/uncertain attempt
        // never replays a partially appended log on restart.
        save(false);
        output=await persistence.create({...header,id:expected,cwd,createdAt:Date.now()},{...options,inheritedEventCount:input.inheritedEventCount});
        await output.append(events,options);await output.flush(options);await output.close();output=undefined;
        save(true);
      } finally { try { await output?.close(); } finally { await input?.close(); } }
    };
    const wrapped = async function(id, access, options) {
      if(id===expected){pending??=materialize(options);await pending;}
      return original.call(this,id,access,options);
    };
    persistence.open=wrapped;
    child.on('dispose',()=>{if(persistence.open===wrapped)persistence.open=original;});
  });
}
export function apply(ctx, config) {
  const { directory, token, cwd, expected } = config;
  if (!path.isAbsolute(directory) || !path.isAbsolute(cwd) || !/^[a-f0-9]{64}$/.test(token)) return;
  installContinuation(ctx,config);
  const norm = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const safe = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,199}$/.test(value);
  const write = (name, value) => {
    const file = path.join(directory, name), temp = file + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(value), {mode:0o600}); fs.renameSync(temp,file); } finally {try{fs.unlinkSync(temp)}catch{}}
  };
  let bound, channel, off, registryOff, lastState, saved, active=false, disposed=false, loading=false, models=[], catalogAt=0;
  let contextModel, rejectedUsage, lastContext, invalidContext=false;
  const projected=new Set();
  const base = () => ({token,id:bound,cwd,at:new Date().toISOString()});
  const status = (state,event,attention) => {
    const value={...base(),provider:'dsh',state,event,attention};write('status.json',value);
    if(config.statusFile){const temp=config.statusFile+'.'+process.pid+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,config.statusFile)}finally{try{fs.unlinkSync(temp)}catch{}}}
  };
  const transcript = row => {
    const file=path.join(directory,'conversation.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size>16*1024*1024) {
      const bytes=fs.readFileSync(file),tail=bytes.subarray(Math.max(0,bytes.length-8*1024*1024)),newline=tail.indexOf(10),temp=file+'.tmp';
      const header=Buffer.from(JSON.stringify({type:'session_meta',payload:{id:bound,cwd}})+'\n');
      fs.writeFileSync(temp,Buffer.concat([header,newline<0?Buffer.alloc(0):tail.subarray(newline+1)]),{mode:0o600});fs.renameSync(temp,file);
    }
    const line=JSON.stringify(row); if(Buffer.byteLength(line)<=262144) fs.appendFileSync(file,line+'\n',{mode:0o600});
  };
  const project = event => {
    if(!Number.isSafeInteger(event.seq)||event.seq<0||projected.has(event.seq))return;
    projected.add(event.seq);if(projected.size>4000)projected.delete(projected.values().next().value);
    const data=event.data, timestamp=new Date(event.time).toISOString();
    if(event.type==='compaction/end'&&typeof data?.compactionId==='string'&&data.compactionId.length<=200&&!data.error)transcript({type:'compacted',timestamp,id:data.compactionId});
    if (event.type==='request/header' && data?.header?.config) {const config=data.header.config;transcript({type:'turn_context',payload:{model:safe(config.provider)&&safe(config.model)?config.provider+'/'+config.model:undefined,effort:config.reasoningEffort}});}
    const message=event.type==='user/message'?data:event.type==='assistant/message'?data?.message:null;
    if(message && (message.role==='assistant' && message.source?.kind==='model' || message.role==='user' && message.source?.kind==='user')) {
      const content=Array.isArray(message.content)?message.content.filter(p=>p?.type==='text'&&typeof p.text==='string').map(p=>({type:'text',text:p.text.slice(0,100000)})):[];
      if(content.length)transcript({type:'response_item',timestamp,payload:{type:'message',id:message.id??String(event.seq),nativeSeq:event.seq,hasAttachments:message.role==='user'&&Array.isArray(message.content)&&message.content.some(p=>p?.type!=='text'),role:message.role,content}});
    }
    if(event.type==='tool/call' && typeof data?.name==='string' && typeof data.arguments==='string') transcript({type:'response_item',timestamp,payload:{type:'function_call',call_id:data.callId,name:data.name,arguments:data.arguments.slice(0,32768)}});
  };
  const bind = session => {
    const h=session?.header;
    if(!h||typeof h.cwd!=='string'||norm(h.cwd)!==norm(cwd)||h.parentSession||h.origin==='subagent'||!safe(h.id)||(expected&&h.id!==expected)||(bound&&h.id!==bound))return false;
    if(bound)return true;
    bound=h.id;
    fs.writeFileSync(path.join(directory,'conversation.jsonl'),JSON.stringify({type:'session_meta',payload:{id:bound,cwd}})+'\n',{mode:0o600});
    const events=typeof session.snapshotEvents==='function'?session.snapshotEvents():session.events;
    if(Array.isArray(events))for(const event of events.slice(-2000))try{project(event)}catch{}
    write('binding.json',base());status('idle','SessionStart');return true;
  };
  ctx.on('session/created',session=>{try{bind(session)}catch{}});
  ctx.on('session/event',(session,event)=>{
    try{
      if(!bind(session)||session.id!==bound)return;
      project(event);
      if(event.type==='turn/start'){active=true;status('working','UserPromptSubmit');}
      else if(event.type==='tool/call'&&active)status(['ask_user_question','AskUserQuestion'].includes(event.data?.name)?'waiting':'working','PreToolUse',['ask_user_question','AskUserQuestion'].includes(event.data?.name)?'question':undefined);
      else if(event.type==='tool/result'&&active)status('working','PostToolUse');
      else if(event.type==='turn/end'&&active){active=false;const kind=event.data?.reason?.kind;status(kind==='completed'?'completed':kind==='error'?'failed':kind==='aborted'&&event.data?.reason?.reason?.kind==='user'?'interrupted':kind==='blocked'?'blocked':'unknown','Stop');}
    }catch{}
  });
  // The TUI registration is observed only; native slash commands own mutations.
  const attach=async()=>{
    if(disposed||loading)return;loading=true;
    try {
      if(!registryOff && config.registry){
        const registry=await import(pathToFileURL(config.registry).href);
        if(disposed)return;
        const mount=registration=>{if(disposed)return;off?.();channel=registration?.channel;models=[];catalogAt=0;if(channel){off=channel.subscribe(()=>{void snapshot().catch(()=>{})});}void snapshot().catch(()=>{});};
        registryOff=registry.onTuiChannelRegistration(ctx,mount);mount(registry.getTuiChannelRegistration(ctx));
      }
      if(channel && Date.now()-catalogAt>60000 && typeof channel.listModels==='function'){
        const rows=await channel.listModels();const next=[];
        for(const model of rows.slice(0,200)){
          if(!safe(model.provider)||!safe(model.id))continue;
          let levels;try{levels=await channel.listEfforts({provider:model.provider,model:model.id})}catch{}
          const efforts=levels?.levelsFallback?[]:(levels?.efforts??[]).slice(0,16).filter(e=>safe(e.id)).map(e=>({value:e.id,label:typeof e.name==='string'?e.name.slice(0,80):e.id}));
          next.push({id:model.provider+'/'+model.id,label:typeof model.name==='string'?model.name.slice(0,160):model.id,efforts});
        }
        if(disposed)return;models=next;catalogAt=next.length?Date.now():0;
      }
      if(bound && saved!==true){
        const persistence=ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence;
        if(typeof persistence?.stat==='function'){
          const observed=await persistence.stat(bound);
          if(disposed)return;
          const durable=observed?.header?.id===bound && Number.isFinite(observed.sizeBytes) && observed.sizeBytes>0;
          if(saved!==durable){saved=durable;write('binding.json',{...base(),saved});}
        }
      }
      await snapshot();
    }catch{}finally{loading=false}
  };
  const snapshot=async()=>{
    if(disposed||!bound)return;
    if(!channel||channel.sessionId!==bound||channel.backendCapabilities?.backendId&&channel.backendCapabilities.backendId!=='dsh'){
      const value='unbound';if(lastState===value)return;lastState=value;write('options.json',{...base(),current:{},models:[],ready:false});return;
    }
    const current={model:safe(channel.provider)&&safe(channel.model)?channel.provider+'/'+channel.model:undefined,effort:safe(channel.reasoningEffort)?channel.reasoningEffort:undefined};
    const usage=channel.lastUsage;
    if(contextModel && contextModel!==current.model){rejectedUsage=usage;invalidContext=true;}
    if(invalidContext && rejectedUsage!==usage)invalidContext=false;
    contextModel=current.model;
    const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e12?value:undefined;
    const input=usage!==rejectedUsage?count(usage?.input):undefined,read=count(usage?.cacheRead),cacheWrite=count(usage?.cacheWrite);
    const occupancy=!invalidContext?channel.contextOccupancy:undefined;
    const nativeUsed=['projection','backend','sample'].includes(occupancy?.source)&&Number.isFinite(occupancy.usedTokens)&&occupancy.usedTokens>=0&&occupancy.usedTokens<=1e12?Math.round(occupancy.usedTokens):undefined;
    const context={usedTokens:nativeUsed??(input===undefined?null:input+(read??0)+(cacheWrite??0)),windowTokens:count(occupancy?.contextWindow)??count(channel.contextWindow)??null,
      measurement:nativeUsed!==undefined&&occupancy.source!=='sample'?'reported':'last-request',estimated:nativeUsed!==undefined&&occupancy.source==='projection',
      ...(input===undefined?{}:{inputTokens:input,outputTokens:count(usage?.output),cacheReadTokens:read,cacheWriteTokens:cacheWrite})};
    const contextKey=JSON.stringify(context);
    if(contextKey!==lastContext){lastContext=contextKey;transcript({type:'context_usage',timestamp:new Date().toISOString(),payload:context});}
    const permissionSnapshot=typeof channel.permissionPresets==='function'?channel.permissionPresets():undefined;
    const permissions=permissionSnapshot?.availability==='runtime'?(permissionSnapshot.options??[]).slice(0,32).filter(p=>safe(p.value)&&typeof p.name==='string').map(p=>({value:p.value,label:p.name.slice(0,160),...(typeof p.description==='string'?{description:p.description.slice(0,400)}:{})})):[];
    if(safe(permissionSnapshot?.current?.value))current.permission=permissionSnapshot.current.value;
    const ready=channel.ready===true;
    const value=JSON.stringify({current,models,ready,permissions});if(value===lastState)return;lastState=value;
    write('options.json',{...base(),current,models,ready,permissions});
  };
  const timer=setInterval(()=>{void attach()},1000);timer.unref?.();
  const catalogTimer=setInterval(()=>{void attach()},60000);catalogTimer.unref?.();
  ctx.on('dispose',()=>{disposed=true;clearInterval(timer);clearInterval(catalogTimer);off?.();registryOff?.()});
  ctx.on('ready',()=>{void attach()});
}
`;
