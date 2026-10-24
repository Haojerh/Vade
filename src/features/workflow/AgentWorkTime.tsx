import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import type { Node } from '../../../shared/contracts';

function duration(milliseconds:number){const seconds=Math.max(0,Math.floor(milliseconds/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);return hours?`${hours}h ${minutes}m ${seconds%60}s`:minutes?`${minutes}m ${seconds%60}s`:`${seconds}s`;}
export function AgentWorkTime({node}:{node:Node}) {
  const time=node.agentStatus?.data?.workTime;
  const active=Boolean(time?.activeSince&&node.state==='working'&&node.liveness==='live'&&!node.stale&&node.agentStatus?.meta.availability==='ready');
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{setNow(Date.now());if(!active)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active,time?.activeSince]);
  if(!time)return null;
  const total=time.workedMs+(active?Math.max(0,now-Date.parse(time.activeSince!)):0);
  return <div className="agent-work-time" title={time.partial?'Measured from observed working activity; earlier work may not be included.':'Time spent in observed Working state; waiting is excluded.'}><Timer size={14}/><span>{time.partial?'Observed work':active?'Working':'Worked for'} <time>{duration(total)}</time>{!active&&!time.endedAt?' · paused':''}</span></div>;
}
