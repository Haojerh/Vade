import type { AgentStatus, AgentWorkTime, Section } from '../../shared/contracts.js';
import type { SessionRecord } from './store.js';

type Clock = { token?: string; started: number; active: number | null; worked: number; ended: number | null; partial: boolean; last: number };
/** Measures observed working intervals only; never treats input or liveness as work. */
export class AgentWorkClock {
  private clocks = new Map<string,Clock>();
  observe(record: SessionRecord, status: Section<AgentStatus>, now = Date.now()): AgentWorkTime | undefined {
    let clock=this.clocks.get(record.id);
    if(clock?.token!==record.statusToken){this.clocks.delete(record.id);clock=undefined;}
    const state=status.meta.availability==='ready'?status.data?.state:undefined;
    const observed=Date.parse(status.meta.observedAt??'');
    const timestamp=Math.min(now,observed||now);
    if(state==='working'&&(!clock||clock.ended!==null&&timestamp>clock.ended)) {
      if(this.clocks.size>=512){const old=[...this.clocks].find(([,value])=>value.active===null)?.[0];if(old)this.clocks.delete(old);}
      const start=Boolean(observed)&&['UserPromptSubmit','PreInvocation'].includes(status.data!.event);
      clock={token:record.statusToken,started:timestamp,active:timestamp,worked:0,ended:null,partial:!start,last:timestamp};this.clocks.set(record.id,clock);
    }
    if(!clock)return undefined;
    if(state==='working'&&clock.active===null&&clock.ended===null)clock.active=Math.max(clock.last,timestamp);
    if(state!=='working'&&clock.active!==null){const end=state?Math.max(clock.last,clock.active,timestamp):now;clock.worked+=Math.max(0,end-clock.active);clock.active=null;clock.last=end;if(!state||state==='unknown')clock.partial=true;}
    if(state&&['completed','failed','interrupted'].includes(state)&&clock.ended===null)clock.ended=Math.max(clock.last,timestamp);
    return {startedAt:new Date(clock.started).toISOString(),activeSince:clock.active===null?null:new Date(clock.active).toISOString(),workedMs:clock.worked,endedAt:clock.ended===null?null:new Date(clock.ended).toISOString(),partial:clock.partial};
  }
}
