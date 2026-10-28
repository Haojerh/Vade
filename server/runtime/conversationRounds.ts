import type {AgentStatus,ConversationRound,Section} from '../../shared/contracts.js';
import type {AdeStore,SessionRecord} from './store.js';
import {hashId,toIsoOrNull} from '../providers/transcriptUtils.js';
import fs from 'node:fs';
import {parseCoordinatorTranscriptLine} from '../providers/publicTranscript.js';

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

/** Native duration records restore older Claude rounds without invented completion or timing. */
export function claudeNativeRounds(sessionId:string,lines:string[],sourceIdentity?:string):ConversationRound[]{
  const rows=lines.flatMap(line=>{try{const row=JSON.parse(line);return row.sessionId===sessionId&&!row.isSidechain&&!row._fromSubAgent?[row]:[];}catch{return [];}});
  const byId=new Map(rows.filter(row=>typeof row.uuid==='string').map(row=>[row.uuid,row]));
  return rows.flatMap(row=>{try{
    const endedAt=toIsoOrNull(row.timestamp),duration=row.durationMs;
    if(row.sessionId!==sessionId||row.isSidechain||row._fromSubAgent||row.type!=='system'||row.subtype!=='turn_duration'||!endedAt||!Number.isSafeInteger(duration)||duration<0||duration>7*24*3600000||typeof row.uuid!=='string')return [];
    const startedAt=new Date(Date.parse(endedAt)-duration).toISOString(),messageIds:string[]=[];
    if(sourceIdentity){let parent=row.parentUuid;const seen=new Set<string>();
      while(typeof parent==='string'&&!seen.has(parent)&&seen.size<2000){seen.add(parent);const ancestor=byId.get(parent);if(!ancestor||Date.parse(ancestor.timestamp)<Date.parse(startedAt))break;
        if(ancestor.subtype==='turn_duration')break;
        const message=parseCoordinatorTranscriptLine(JSON.stringify(ancestor),'claude',sourceIdentity).message;
        if(message)messageIds.unshift(message.id);
        parent=ancestor.parentUuid;
      }
    }
    return [{id:hashId('round',`${sessionId}:${row.uuid}`),startedAt,endedAt,workedMs:duration,partial:false,outcome:'ended' as const,measurement:'native-duration' as const,...(messageIds.length?{messageIds:messageIds.slice(-200)}:{})}];
  }catch{return [];}}).slice(-200);
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

/** Prefer explicit owned outcomes over overlapping native elapsed-duration records. */
export function mergeConversationRounds(saved:ConversationRound[],native:ConversationRound[]):ConversationRound[]{
  const overlaps=(a:ConversationRound,b:ConversationRound)=>a.endedAt===b.endedAt||Date.parse(a.startedAt)<Date.parse(b.endedAt)&&Date.parse(a.endedAt)>Date.parse(b.startedAt);
  return [...saved.map(round=>{const ids=native.filter(other=>overlaps(round,other)).flatMap(other=>other.messageIds??[]);return ids.length?{...round,messageIds:[...new Set(ids)].slice(-200)}:round;}),...native.filter(round=>!saved.some(other=>overlaps(other,round)))].sort((a,b)=>Date.parse(a.endedAt)-Date.parse(b.endedAt)).slice(-200);
}
