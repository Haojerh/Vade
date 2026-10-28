import type {AgentStatus,ConversationRound,Section} from '../../shared/contracts.js';
import type {AdeStore,SessionRecord} from './store.js';
import {hashId,toIsoOrNull} from '../providers/transcriptUtils.js';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {parseCoordinatorTranscriptLine} from '../providers/publicTranscript.js';
import {parseAntigravityTranscriptLine} from '../providers/antigravity.js';
import {isClaudeInterruptionNotice} from '../providers/shared.js';

/** Private native timing/parent-link window, independent of public page limits. */
export function nativeRoundRows(file:string,end:number):string[]{
  const start=Math.max(0,end-4*1024*1024),fd=fs.openSync(file,'r');
  try{const buffer=Buffer.alloc(end-start);const count=fs.readSync(fd,buffer,0,buffer.length,start);let text=buffer.subarray(0,count).toString('utf8');if(start>0){const newline=text.indexOf('\n');text=newline<0?'':text.slice(newline+1);}return text.split('\n').filter(Boolean).slice(-2000);}finally{fs.closeSync(fd);}
}

/** Saved observations are separate from Inbox/task outcomes and survive launches. */
export class ConversationRounds {
  constructor(private store:AdeStore){}
  observe(record:SessionRecord,status:Section<AgentStatus>){
    const time=status.data?.workTime,state=status.data?.state;
    if(status.meta.availability!=='ready'||!time?.endedAt||!['completed','failed','interrupted'].includes(state??'')||!record.providerThreadId||!record.statusToken)return;
    const round:ConversationRound={id:hashId('round',`${record.projectId}:${record.id}:${record.providerThreadId}:${record.statusToken}:${time.startedAt}`),startedAt:time.startedAt,endedAt:time.endedAt,workedMs:time.workedMs,partial:time.partial,outcome:state as ConversationRound['outcome'],measurement:'observed-work'};
    if(!Number.isFinite(Date.parse(round.startedAt))||!Number.isFinite(Date.parse(round.endedAt))||Date.parse(round.endedAt)<Date.parse(round.startedAt)||!Number.isSafeInteger(round.workedMs)||round.workedMs<0)return;
    const changed=this.store.db.prepare('INSERT INTO conversation_rounds VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,ended_at=excluded.ended_at WHERE data<>excluded.data').run(round.id,record.projectId,record.id,record.providerThreadId,round.endedAt,JSON.stringify(round));
    if(!changed.changes)return;
    this.store.db.exec('DELETE FROM conversation_rounds WHERE id NOT IN (SELECT id FROM conversation_rounds ORDER BY ended_at DESC LIMIT 10000)');
  }
  read(record:SessionRecord):ConversationRound[]{
    if(!record.providerThreadId)return [];
    return this.store.db.prepare('SELECT data FROM conversation_rounds WHERE project_id=? AND node_id=? AND thread_id=? ORDER BY ended_at DESC LIMIT 200').all(record.projectId,record.id,record.providerThreadId).map(row=>JSON.parse(String(row.data))).reverse();
  }
}

function claudeParentUuid(row:any):string|undefined {
  if(typeof row?.parentUuid==='string')return row.parentUuid;
  return row?.type==='system'&&row?.subtype==='compact_boundary'&&typeof row.logicalParentUuid==='string'?row.logicalParentUuid:undefined;
}

/** Walk one native turn, bridging the parent reset at a Claude compaction boundary. */
function claudeAncestors(start:string|undefined,byId:Map<string,any>,notBefore=-Infinity):any[]{
  const chain:any[]=[],seen=new Set<string>();let parent=start;
  while(typeof parent==='string'&&!seen.has(parent)&&seen.size<2000){
    seen.add(parent);const ancestor=byId.get(parent);
    if(!ancestor)break;
    const at=Date.parse(ancestor.timestamp);
    if(Number.isFinite(at)&&at<notBefore)break;
    if(ancestor.type==='system'&&ancestor.subtype==='turn_duration')break;
    chain.push(ancestor);
    if(isClaudeInterruptionNotice(ancestor))break;
    parent=claudeParentUuid(ancestor);
  }
  return chain;
}

/** Native duration records restore older Claude rounds without invented completion or timing. */
export function claudeNativeRounds(sessionId:string,lines:string[],sourceIdentity?:string):ConversationRound[]{
  const rows=lines.flatMap(line=>{try{const row=JSON.parse(line);return row.sessionId===sessionId&&!row.isSidechain&&!row._fromSubAgent?[row]:[];}catch{return [];}});
  const byId=new Map(rows.filter(row=>typeof row.uuid==='string').map(row=>[row.uuid,row]));
  const rounds=rows.flatMap(row=>{try{
    const endedAt=toIsoOrNull(row.timestamp),duration=row.durationMs;
    if(row.sessionId!==sessionId||row.isSidechain||row._fromSubAgent||row.type!=='system'||row.subtype!=='turn_duration'||!endedAt||!Number.isSafeInteger(duration)||duration<0||duration>7*24*3600000||typeof row.uuid!=='string')return [];
    const startedAt=new Date(Date.parse(endedAt)-duration).toISOString(),messageIds:string[]=[];
    const ancestors=claudeAncestors(row.parentUuid,byId,Date.parse(startedAt));
    if(sourceIdentity){
      for(const ancestor of ancestors){
        const message=parseCoordinatorTranscriptLine(JSON.stringify(ancestor),'claude',sourceIdentity).message;
        if(message)messageIds.unshift(message.id);
      }
    }
    const outcome=ancestors.some(isClaudeInterruptionNotice)?'interrupted' as const:'ended' as const;
    return [{id:hashId('round',`${sessionId}:${row.uuid}`),startedAt,endedAt,workedMs:duration,partial:false,outcome,measurement:'native-duration' as const,...(messageIds.length?{messageIds:messageIds.slice(-200)}:{})}];
  }catch{return [];}}).slice(-200);
  const interrupted=rows.flatMap(marker=>{try{
    if(!isClaudeInterruptionNotice(marker)||typeof marker.uuid!=='string')return [];
    const endedAt=toIsoOrNull(marker.timestamp);
    if(!endedAt||rounds.some(round=>Date.parse(round.startedAt)<=Date.parse(endedAt)&&Date.parse(round.endedAt)>=Date.parse(endedAt)))return [];
    const ancestors=claudeAncestors(claudeParentUuid(marker),byId),messages=ancestors.flatMap(ancestor=>{
      const message=parseCoordinatorTranscriptLine(JSON.stringify(ancestor),'claude',sourceIdentity??'').message;
      return message?.at?[message]:[];
    });
    const startedAt=messages.find(message=>message.role==='user')?.at;
    if(!startedAt)return [];
    const workedMs=Date.parse(endedAt)-Date.parse(startedAt);
    if(!Number.isFinite(workedMs)||workedMs<0||workedMs>7*24*3600000)return [];
    const messageIds=sourceIdentity?[...new Set(messages.map(message=>message.id))].slice(-200):undefined;
    return [{id:hashId('round',`${sessionId}:${marker.uuid}`),startedAt,endedAt,workedMs,partial:false,outcome:'interrupted' as const,measurement:'native-duration' as const,...(messageIds?.length?{messageIds}:{})}];
  }catch{return [];}});
  return [...rounds,...interrupted].sort((a,b)=>Date.parse(a.endedAt)-Date.parse(b.endedAt)).slice(-200);
}

/** Codex records explicit turn IDs at both native boundaries. Elapsed time is
 * labelled as native duration, never passed off as measured working intervals. */
export function codexNativeRounds(sessionId:string,lines:string[],sourceIdentity?:string):ConversationRound[]{
  const rounds:ConversationRound[]=[],starts=new Map<string,{at:string;messages:string[]}>();let active:string|undefined;
  for(const line of lines){try{
    const row=JSON.parse(line),event=row.payload,at=toIsoOrNull(row.timestamp);
    if(row.isSidechain||row._fromSubAgent||row.sessionId&&row.sessionId!==sessionId)continue;
    if(sourceIdentity&&active&&row.type==='response_item'&&event?.type==='message'&&['user','assistant'].includes(event.role)&&typeof event.id==='string')starts.get(active)?.messages.push(hashId('msg',`${sourceIdentity}:${event.id}`));
    if(row.type!=='event_msg'||!at||typeof event?.turn_id!=='string')continue;
    if(event.type==='task_started'){active=event.turn_id;starts.set(event.turn_id,{at,messages:[]});}
    else if(['task_complete','turn_aborted'].includes(event.type)){
      const start=starts.get(event.turn_id),startedAt=start?.at;starts.delete(event.turn_id);if(active===event.turn_id)active=undefined;
      const duration=startedAt?Date.parse(at)-Date.parse(startedAt):-1;
      if(!startedAt||duration<0||duration>7*24*3600000)continue;
      rounds.push({id:hashId('round',`${sessionId}:${event.turn_id}`),startedAt,endedAt:at,workedMs:duration,partial:false,outcome:event.type==='task_complete'?'completed':'ended',measurement:'native-duration',...(sourceIdentity?{messageIds:start!.messages.slice(-200)}:{})});
    }
  }catch{/* Partial native boundaries never settle a round. */}}
  return rounds.slice(-200);
}

const MAX_NATIVE_ROUND_MS=7*24*60*60*1000;
/** Providers without exact boundaries must not absorb prompts from a later idle period. */
const NATIVE_USER_CONTINUITY_MS=30*60*1000;
function nativeRound(id:string,startedAt:string|null,endedAt:string|null,outcome:ConversationRound['outcome'],messageIds:string[]):ConversationRound|undefined{
  if(!startedAt||!endedAt)return;
  const duration=Date.parse(endedAt)-Date.parse(startedAt);
  if(!Number.isFinite(duration)||duration<0||duration>MAX_NATIVE_ROUND_MS)return;
  return {id,startedAt,endedAt,workedMs:duration,partial:false,outcome,measurement:'native-duration',...(messageIds.length?{messageIds:[...new Set(messageIds)].slice(-200)}:{})};
}

/** DSH's owned observer records exact turn boundaries before projecting public messages. */
export function dshNativeRounds(sessionId:string,lines:string[],sourceIdentity?:string):ConversationRound[]{
  const rounds:ConversationRound[]=[];let active:{turnId:string;startedAt:string;messages:string[]}|undefined;
  for(const line of lines){try{
    const row=JSON.parse(line),at=toIsoOrNull(row.timestamp);
    if(sourceIdentity&&active&&row.type==='response_item'){
      const message=parseCoordinatorTranscriptLine(line,'dsh',sourceIdentity).message;
      if(message)active.messages.push(message.id);
    }
    if((row.type!=='turn_started'&&row.type!=='turn_ended')||typeof row.turnId!=='string'||!at)continue;
    if(row.type==='turn_started'){
      active={turnId:row.turnId,startedAt:at,messages:[]};
      continue;
    }
    if(!active||active.turnId!==row.turnId)continue;
    const kind=row.reason?.kind,outcome=kind==='completed'?'completed':kind==='error'?'failed':kind==='aborted'&&row.reason?.reason?.kind==='user'?'interrupted':'ended';
    const round=nativeRound(hashId('round',`${sessionId}:dsh:${row.turnId}`),active.startedAt,at,outcome,active.messages);
    if(round)rounds.push(round);
    active=undefined;
  }catch{/* An incomplete lifecycle row never settles a round. */}}
  return rounds.slice(-200);
}

/** CodeBuddy request IDs group steering, tool activity and the terminal public reply. */
export function codeBuddyNativeRounds(sessionId:string,lines:string[],sourceIdentity?:string):ConversationRound[]{
  type Evidence={startedAt:string;messages:string[];lastAnswerAt?:string;lastAnswerStatus?:string;lastAnswerError?:string;toolAfterAnswer:boolean};
  const groups=new Map<string,Evidence>();
  for(const line of lines){try{
    const row=JSON.parse(line);
    if(row.sessionId!==sessionId||row.isSidechain||row._fromSubAgent)continue;
    const requestId=row.providerData?.conversationRequestId;
    if(typeof requestId!=='string'||!requestId||requestId.length>200)continue;
    let evidence=groups.get(requestId);
    if(row.providerData?.skipRun===true){
      const at=toIsoOrNull(row.timestamp),error=typeof row.providerData?.error?.message==='string'?row.providerData.error.message:undefined;
      if(evidence&&row.type==='message'&&row.role==='assistant'&&at&&error?.trim().toLowerCase()==='interrupted by user'){
        evidence.lastAnswerAt=at;evidence.lastAnswerStatus=row.status;evidence.lastAnswerError=error;evidence.toolAfterAnswer=false;
        groups.set(requestId,evidence);
      }
      continue;
    }
    const message=parseCoordinatorTranscriptLine(line,'codebuddy',sourceIdentity??'').message;
    if(message?.role==='user'){
      evidence??= {startedAt:message.at!,messages:[],toolAfterAnswer:false};
      evidence.startedAt=evidence.startedAt<message.at!?evidence.startedAt:message.at!;
      evidence.messages.push(message.id);
    }else if(message?.role==='agent'&&message.text.trim()){
      evidence??= {startedAt:message.at!,messages:[],toolAfterAnswer:false};
      evidence.messages.push(message.id);evidence.lastAnswerAt=message.at??undefined;
      evidence.lastAnswerStatus=typeof row.status==='string'?row.status:undefined;
      evidence.lastAnswerError=typeof row.providerData?.error?.message==='string'?row.providerData.error.message:undefined;
      evidence.toolAfterAnswer=false;
    }else if(evidence&&['function_call','function_call_result'].includes(row.type))evidence.toolAfterAnswer=true;
    if(evidence)groups.set(requestId,evidence);
  }catch{/* Partial request records remain unsettled. */}}
  return [...groups].flatMap(([requestId,evidence])=>{
    if(!evidence.lastAnswerAt||evidence.toolAfterAnswer||!evidence.startedAt)return [];
    const outcome=/interrupt/i.test(evidence.lastAnswerError??'')?'interrupted':evidence.lastAnswerError?'failed':evidence.lastAnswerStatus==='completed'?'completed':'ended';
    const round=nativeRound(hashId('round',`${sessionId}:codebuddy:${requestId}`),evidence.startedAt,evidence.lastAnswerAt,outcome,evidence.messages);
    return round?[round]:[];
  }).slice(-200);
}

/** Antigravity closes a turn only after a final planner response with no later tool call. */
export function antigravityNativeRounds(lines:string[],sourceIdentity?:string):ConversationRound[]{
  const rounds:ConversationRound[]=[];
  let active:{firstId:string;startedAt:string;lastActivityAt:string;messages:string[];answerAt?:string}|undefined;
  const close=()=>{
    if(!active?.answerAt)return;
    const round=nativeRound(hashId('round',`antigravity:${sourceIdentity??''}:${active.firstId}`),active.startedAt,active.answerAt,'ended',active.messages);
    if(round)rounds.push(round);
  };
  for(const line of lines){try{
    const row=JSON.parse(line),activityAt=toIsoOrNull(row.created_at);
    if(row.type==='USER_INPUT'){
      const message=parseAntigravityTranscriptLine(line,sourceIdentity??'').message;
      if(!message||message.role!=='user'||!message.at)continue;
      if(active?.answerAt||active&&Date.parse(message.at)-Date.parse(active.lastActivityAt)>NATIVE_USER_CONTINUITY_MS){close();active=undefined;}
      active??={firstId:message.id,startedAt:message.at,lastActivityAt:message.at,messages:[]};
      active.messages.push(message.id);
      active.lastActivityAt=message.at;
      continue;
    }
    if(active&&activityAt)active.lastActivityAt=activityAt;
    if(!active||row.type!=='PLANNER_RESPONSE')continue;
    if(Array.isArray(row.tool_calls)&&row.tool_calls.length){
      active.answerAt=undefined;
      continue;
    }
    const message=parseAntigravityTranscriptLine(line,sourceIdentity??'').message;
    if(message?.role==='agent'&&message.text.trim()&&message.at){
      active.messages.push(message.id);active.answerAt=message.at;
    }
  }catch{/* Malformed native rows cannot settle a turn. */}}
  close();
  return rounds.slice(-200);
}

function openCodeV1HasText(db:DatabaseSync,sessionId:string):Set<string>{
  return new Set((db.prepare(`SELECT DISTINCT message_id FROM (
    SELECT rowid,message_id,data FROM part WHERE session_id=? AND length(CAST(data AS BLOB))<=2097152 ORDER BY rowid DESC LIMIT 4000
  ) WHERE json_extract(data,'$.type')='text' AND COALESCE(json_extract(data,'$.synthetic'),0)=0`).all(sessionId) as any[])
    .flatMap(row=>typeof row.message_id==='string'?[row.message_id]:[]));
}

/** OpenCode/Kilo v1 links assistant messages to the user message through parentID. */
export function openCodeNativeRounds(file:string,sessionId:string,sourceIdentity?:string):ConversationRound[]{
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const rows=db.prepare(`SELECT rowid,id,time_created,data FROM (
      SELECT rowid,id,time_created,data FROM message WHERE session_id=? ORDER BY rowid DESC LIMIT 2000
    ) ORDER BY rowid`).all(sessionId) as any[];
    const hasText=openCodeV1HasText(db,sessionId),users=new Map<string,{at:string;id:string}>();
    const assistants=new Map<string,Array<{id:string;at?:string;completedAt?:string;finish?:string;errorName?:string}>>();
    for(const row of rows){
      if(typeof row.id!=='string'||typeof row.data!=='string')continue;
      let data:any;try{data=JSON.parse(row.data);}catch{continue;}
      if(data.summary===true&&data.mode==='compaction')continue;
      const at=toIsoOrNull(data.time?.created)??toIsoOrNull(row.time_created);
      if(data.role==='user'&&at&&hasText.has(row.id))users.set(row.id,{at,id:row.id});
      else if(data.role==='assistant'&&typeof data.parentID==='string'){
        const errorName=typeof data.error?.name==='string'?data.error.name:undefined;
        if(!hasText.has(row.id)&&errorName!=='MessageAbortedError')continue;
        const list=assistants.get(data.parentID)??[];
        list.push({id:row.id,at:at??undefined,completedAt:toIsoOrNull(data.time?.completed)??undefined,finish:typeof data.finish==='string'?data.finish:undefined,errorName});
        assistants.set(data.parentID,list);
      }
    }
    return [...users].flatMap(([parentId,user])=>{
      const linked=assistants.get(parentId);if(!linked?.length)return [];
      const final=linked.at(-1)!;
      if(final.finish==='tool-calls')return [];
      const endedAt=final.completedAt??final.at;if(!endedAt)return [];
      const outcome=final.errorName==='MessageAbortedError'?'interrupted':final.errorName?'failed':final.finish==='stop'?'completed':'ended';
      const messageIds=[hashId('msg',`${sourceIdentity}:${user.id}`),...linked.map(item=>hashId('msg',`${sourceIdentity}:${item.id}`))];
      const round=nativeRound(hashId('round',`${sessionId}:opencode:${parentId}`),user.at,endedAt,outcome,messageIds);
      return round?[round]:[];
    }).slice(-200);
  }finally{db.close();}
}

function openCodeV2Text(data:any):string{
  if(Array.isArray(data?.content))return data.content.flatMap((part:any)=>part?.type==='text'&&!part.synthetic&&typeof part.text==='string'?[part.text]:[]).join('\n').trim();
  if(typeof data?.text==='string')return data.text.trim();
  if(Array.isArray(data?.text))return data.text.filter((part:unknown)=>typeof part==='string').join('\n').trim();
  return '';
}

/** OpenCode v2 records an idle row with the terminal outcome for each user turn. */
export function openCodeV2NativeRounds(file:string,sessionId:string,sourceIdentity?:string):ConversationRound[]{
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const rows=db.prepare(`SELECT seq,id,type,time_created,data FROM (
      SELECT seq,id,type,time_created,data FROM session_message WHERE session_id=? ORDER BY seq DESC LIMIT 2000
    ) ORDER BY seq`).all(sessionId) as any[];
    const rounds:ConversationRound[]=[];
    let active:{firstId:string;startedAt:string;lastActivityAt:string;messages:string[];lastAssistantAt?:string;lastAssistantFinish?:string;lastAssistantError?:string}|undefined;
    const close=(endedAt:string|null,outcome:ConversationRound['outcome'])=>{
      if(!active)return;
      const round=nativeRound(hashId('round',`${sessionId}:opencode2:${active.firstId}`),active.startedAt,endedAt,outcome,active.messages);
      if(round)rounds.push(round);
      active=undefined;
    };
    const terminalOutcome=()=>active?.lastAssistantError==='MessageAbortedError'?'interrupted':active?.lastAssistantError?'failed':active?.lastAssistantFinish==='stop'?'completed':'ended';
    for(const row of rows){
      if(typeof row.data!=='string')continue;
      let data:any;try{data=JSON.parse(row.data);}catch{continue;}
      const at=toIsoOrNull(row.time_created)??toIsoOrNull(data.time?.created);
      if(row.type==='user'){
        if(data.synthetic||data.isMeta||data.isApiErrorMessage||!openCodeV2Text(data)||!at)continue;
        if(active?.lastAssistantAt&&active.lastAssistantFinish&&active.lastAssistantFinish!=='tool-calls')close(active.lastAssistantAt,terminalOutcome());
        if(active&&Date.parse(at)-Date.parse(active.lastActivityAt)>NATIVE_USER_CONTINUITY_MS)active=undefined;
        active??={firstId:row.id,startedAt:at,lastActivityAt:at,messages:[]};
        active.messages.push(hashId('msg',`${sourceIdentity}:${row.id}`));
        active.lastActivityAt=at;
      }else if(row.type==='assistant'&&active){
        if(at)active.lastActivityAt=at;
        const text=openCodeV2Text(data),aborted=data.error?.name==='MessageAbortedError';
        if(data.synthetic||data.isMeta||data.isApiErrorMessage||(!text&&!aborted))continue;
        if(text)active.messages.push(hashId('msg',`${sourceIdentity}:${row.id}`));
        active.lastAssistantAt=toIsoOrNull(data.time?.completed)??at??undefined;
        active.lastAssistantFinish=typeof data.finish==='string'?data.finish:undefined;
        active.lastAssistantError=typeof data.error?.name==='string'?data.error.name:undefined;
      }else if(row.type==='idle'&&active){
        if(at)active.lastActivityAt=at;
        const outcome=active.lastAssistantError==='MessageAbortedError'?'interrupted':data.outcome==='succeeded'?'completed':data.outcome==='interrupted'?'interrupted':data.outcome==='failed'?'failed':'ended';
        close(at,outcome);
      }else if(active&&at){
        active.lastActivityAt=at;
      }
    }
    if(active?.lastAssistantAt&&active.lastAssistantFinish!=='tool-calls')close(active.lastAssistantAt,terminalOutcome());
    return rounds.slice(-200);
  }finally{db.close();}
}

/** Prefer explicit owned outcomes over overlapping native elapsed-duration records. */
export function mergeConversationRounds(saved:ConversationRound[],native:ConversationRound[]):ConversationRound[]{
  const overlaps=(a:ConversationRound,b:ConversationRound)=>a.endedAt===b.endedAt||Date.parse(a.startedAt)<Date.parse(b.endedAt)&&Date.parse(a.endedAt)>Date.parse(b.startedAt);
  return [...saved.map(round=>{const matching=native.filter(other=>overlaps(round,other)),ids=matching.flatMap(other=>other.messageIds??[]),interrupted=matching.some(other=>other.outcome==='interrupted');return {...round,...(ids.length?{messageIds:[...new Set(ids)].slice(-200)}:{}),...(interrupted?{outcome:'interrupted' as const}:{})};}),...native.filter(round=>!saved.some(other=>overlaps(other,round)))].sort((a,b)=>Date.parse(a.endedAt)-Date.parse(b.endedAt)).slice(-200);
}
