import {createContext,useContext,useEffect,useId,useState,type ReactNode} from 'react';
import type {ConversationRound} from '../../../../shared/contracts';
import {Disclosure} from '../../../components/ui/Disclosure';
import type {ConversationTimelineEntry} from './toolGroups';

export type RoundEntry=ConversationTimelineEntry|{kind:'round';id:string;round:ConversationRound;activities:ConversationTimelineEntry[];distributed?:boolean}|{kind:'round-activity';id:string;round:ConversationRound;entry:ConversationTimelineEntry};
const at=(value:string|null)=>value?Date.parse(value):NaN;
const time=(entry:ConversationTimelineEntry)=>entry.kind==='message'?at(entry.message.at):Math.max(...entry.tools.map(tool=>at(tool.at)));

/** A saved settlement is required. Trailing silence or a later prompt is never completion evidence. */
export function groupSettledRounds(entries:ConversationTimelineEntry[],rounds:ConversationRound[],active=false):RoundEntry[]{
  const native=rounds.filter(round=>round.messageIds?.length);
  if(native.length){
    const owners=new Map<ConversationTimelineEntry,ConversationRound>();
    for(const entry of entries){
      const matches=native.filter(round=>entry.kind==='message'?round.messageIds!.includes(entry.id):entry.tools.length>0&&entry.tools.every(tool=>at(tool.at)>=at(round.startedAt)&&at(tool.at)<=at(round.endedAt)));
      if(matches.length===1)owners.set(entry,matches[0]);
    }
    const headers=new Map<string,{round:ConversationRound;activities:ConversationTimelineEntry[];answer?:ConversationTimelineEntry}>();
    for(const round of native){
      const owned=entries.filter(entry=>owners.get(entry)===round);
      if(!owned.length||active&&owned.includes(entries.at(-1)!))continue;
      const answer=[...owned].reverse().find(entry=>entry.kind==='message'&&entry.message.role==='agent'&&!entry.message.kind&&entry.message.text.trim());
      const activities=owned.filter(entry=>entry!==answer&&(entry.kind==='tools'||entry.message.role!=='user'&&!entry.message.kind));
      headers.set(round.id,{round,activities,answer});
    }
    const inserted=new Set<string>(),result:RoundEntry[]=[];
    for(const entry of entries){
      const owner=owners.get(entry),header=owner?headers.get(owner.id):undefined;
      if(!header){result.push(entry);continue;}
      if(!inserted.has(header.round.id)){
        result.push(...entries.filter(item=>owners.get(item)===owner&&item.kind==='message'&&item.message.role==='user'));
        result.push({kind:'round',id:header.round.id,round:header.round,activities:header.activities,distributed:true});inserted.add(header.round.id);
      }
      if(entry.kind==='message'&&entry.message.role==='user')continue;
      if(header.activities.includes(entry))result.push({kind:'round-activity',id:entry.id,round:header.round,entry});else result.push(entry);
    }
    return result;
  }
  const result:RoundEntry[]=[];
  for(let index=0;index<entries.length;){
    const user=entries[index];
    if(user.kind!=='message'||user.message.role!=='user'){result.push(user);index++;continue;}
    let next=index+1;while(next<entries.length&&!(entries[next].kind==='message'&&(entries[next] as Extract<ConversationTimelineEntry,{kind:'message'}>).message.role==='user'))next++;
    const nextAt=next<entries.length?at(entries[next].at):Infinity,userAt=at(user.at);
    const previousUser=entries.slice(0,index).reverse().find(entry=>entry.kind==='message'&&entry.message.role==='user');
    const body=entries.slice(index+1,next);
    // A settlement describes this turn only while it began before the turn's last visible
    // record. Native turn starts can precede the recorded prompt by a fraction of a second,
    // so no lower bound is applied; an unrelated round from another day still cannot claim
    // this turn because it would have to begin after that last record.
    const lastBodyAt=body.reduce((latest,entry)=>{const value=time(entry);return Number.isFinite(value)&&value>latest?value:latest;},userAt);
    const round=rounds.filter(round=>at(round.endedAt)>=userAt&&at(round.endedAt)<nextAt&&at(round.startedAt)<=lastBodyAt&&(!previousUser||at(previousUser.at)<at(round.startedAt))).at(-1);
    result.push(user);
    if(!round||!Number.isFinite(userAt)||active&&next===entries.length){result.push(...body);index=next;continue;}
    const settled=body.filter(entry=>Number.isFinite(time(entry))&&time(entry)<=at(round.endedAt));
    const answer=[...settled].reverse().find(entry=>entry.kind==='message'&&!entry.message.kind&&entry.message.role==='agent'&&entry.message.text.trim());
    const activities=settled.filter(entry=>entry!==answer&&(entry.kind==='tools'||!entry.message.kind));
    const hidden=new Set(activities);let inserted=false;
    for(const entry of body){
      if(!inserted&&(hidden.has(entry)||entry===answer)){result.push({kind:'round',id:round.id,round,activities});inserted=true;}
      if(!hidden.has(entry))result.push(entry);
    }
    if(!inserted)result.push({kind:'round',id:round.id,round,activities});
    index=next;
  }
  return result;
}

export function mergeRoundObservations(current:ConversationRound[],incoming:ConversationRound[]):ConversationRound[]{
  const merged=new Map(current.map(round=>[round.id,round]));
  for(const round of incoming){const previous=merged.get(round.id);merged.set(round.id,{...round,...(previous?.messageIds?.length||round.messageIds?.length?{messageIds:[...new Set([...(previous?.messageIds??[]),...(round.messageIds??[])])]}:{})});}
  return [...merged.values()].sort((a,b)=>at(a.endedAt)-at(b.endedAt));
}

const storage='ade:conversation-rounds:v1';
function saved():Record<string,boolean>{try{const text=localStorage.getItem(storage)??'{}';if(text.length>131072)return {};const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([key,value])=>key.length<400&&typeof value==='boolean').slice(-200)) as Record<string,boolean>:{};}catch{return {};}}
export const readRoundExpansion=(key:string)=>saved()[key]===true;
export function persistRoundExpansion(key:string,value:boolean){try{const values=saved();delete values[key];localStorage.setItem(storage,JSON.stringify(Object.fromEntries([...Object.entries(values),[key,value]].slice(-200))));}catch{/* Grouping remains available without browser preference storage. */}}
const RoundState=createContext<{open:(id:string)=>boolean;toggle:(id:string,value:boolean)=>void;activityId:(id:string)=>string}|null>(null);
export function ConversationRoundState({scope,children}:{scope:string;children:ReactNode}){
  const [values,setValues]=useState(saved),prefix=useId();
  return <RoundState.Provider value={{open:id=>values[`${scope}:${id}`]===true,toggle:(id,value)=>{const key=`${scope}:${id}`;setValues(current=>({...current,[key]:value}));persistRoundExpansion(key,value);},activityId:id=>`${prefix}-${id}`}}>{children}</RoundState.Provider>;
}
export function ConversationRoundActivity({round,entryId,children}:{round:ConversationRound;entryId:string;children:ReactNode}){
  const state=useContext(RoundState);return <div id={state?.activityId(entryId)} className="conversation-round-activity" hidden={!state?.open(round.id)} inert={!state?.open(round.id)}>{state?.open(round.id)?children:null}</div>;
}
export function roundLabel(round:ConversationRound){
  const seconds=Math.floor(round.workedMs/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);
  const duration=hours?`${hours}h ${minutes%60}m ${seconds%60}s`:minutes?`${minutes}m ${seconds%60}s`:`${seconds}s`;
  return `${round.outcome==='interrupted'?'Interrupted after':round.outcome==='failed'?'Failed after':round.partial?'Observed work':'Worked for'} ${duration}`;
}
export function ConversationRoundGroup({scope,round,children,hasActivities,activityIds}:{scope:string;round:ConversationRound;children:ReactNode;hasActivities:boolean;activityIds?:string[]}){
  const state=useContext(RoundState);
  const key=`${scope}:${round.id}`,[open,setOpen]=useState(false);
  useEffect(()=>{setOpen(readRoundExpansion(key));},[key]);
  const title=round.measurement==='native-duration'?'Elapsed duration recorded by the provider.':round.partial?'Observed working time; earlier activity may be missing.':'Observed working time; waiting is excluded.';
  if(!hasActivities)return <div className="conversation-round-label" data-outcome={round.outcome} title={title}>{roundLabel(round)}</div>;
  return <div className="conversation-round" data-outcome={round.outcome} title={title}><Disclosure title={roundLabel(round)} compact chevronEnd lazy externalControls={activityIds?.map(id=>state?.activityId(id)).filter(Boolean).join(' ')||undefined} open={state?state.open(round.id):open} onOpenChange={value=>{if(state)state.toggle(round.id,value);else{setOpen(value);persistRoundExpansion(key,value);}}}>{activityIds?null:<div className="conversation-round-activities">{children}</div>}</Disclosure></div>;
}
