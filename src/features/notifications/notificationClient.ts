import type { NotificationState, UpdateNotificationStateRequest } from '../../../shared/contracts';
import { emptyNotificationState, mergeNotificationState } from '../../../shared/notificationState';
type Snapshot = { state: NotificationState | null; error: string | null };
type Job = { request: UpdateNotificationStateRequest; resolve: () => void; reject: (error: unknown) => void };
type Entry = { server: NotificationState; loaded: boolean; view: Snapshot; listeners: Set<() => void>; pending: Job[]; sending: boolean };
export class NotificationClient {
  private entries = new Map<string, Entry>();
  private reading = false;
  constructor(private adapter: { read(scopes: string[]): Promise<{ states: Record<string, NotificationState> }>; write(request: UpdateNotificationStateRequest): Promise<NotificationState> }) {}
  private entry(scope: string): Entry {
    let value = this.entries.get(scope);
    if (!value) {
      if (this.entries.size >= 128) { const old = [...this.entries].find(([,entry]) => !entry.listeners.size && !entry.pending.length && !entry.sending); if (old) this.entries.delete(old[0]); }
      value = { server: emptyNotificationState(), loaded: false, view: { state: null, error: null }, listeners: new Set(), pending: [], sending: false }; this.entries.set(scope, value);
    }
    return value;
  }
  snapshot = (scope: string): Snapshot => this.entry(scope).view;
  subscribe(scope: string, listener: () => void): () => void { const entry=this.entry(scope); entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; }
  private publish(entry: Entry, error = entry.view.error) {
    const state=entry.loaded ? entry.pending.reduce((value,job)=>mergeNotificationState(value,job.request),entry.server) : entry.pending.length ? entry.pending.reduce((value,job)=>mergeNotificationState(value,job.request),entry.server) : null;
    if (JSON.stringify(state) === JSON.stringify(entry.view.state) && error === entry.view.error) return;
    entry.view={state,error}; entry.listeners.forEach(listener=>listener());
  }
  private accept(entry: Entry, state: NotificationState) {
    if (!entry.loaded || state.revision >= entry.server.revision) { entry.server=state; entry.loaded=true; }
  }
  update(request: UpdateNotificationStateRequest): Promise<void> {
    const entry=this.entry(request.scope);
    const promise=new Promise<void>((resolve,reject)=>{entry.pending.push({request,resolve,reject});});
    this.publish(entry); void this.flush(entry); return promise;
  }
  retry(scope: string): Promise<void> { const entry=this.entry(scope); void this.flush(entry); return Promise.resolve(); }
  private async flush(entry: Entry) {
    if(entry.sending)return;entry.sending=true;
    try { while(entry.pending.length) {
      const job=entry.pending[0];
      try { const state=await this.adapter.write(job.request); this.accept(entry,state);entry.pending.shift();this.publish(entry,entry.pending.length?entry.view.error:null);job.resolve(); }
      catch(error){this.publish(entry,'Notification changes could not sync. Try again when connected.');job.reject(error);break;}
    }} finally {entry.sending=false;}
  }
  async refresh(): Promise<void> {
    if(this.reading)return;this.reading=true;
    try {
      const watched=[...this.entries].filter(([,entry])=>entry.listeners.size);
      for(let index=0;index<watched.length;index+=8){
        const group=watched.slice(index,index+8);
        try { const response=await this.adapter.read(group.map(([scope])=>scope));
          for(const [scope,entry] of group){const state=response.states[scope];if(state){this.accept(entry,state);this.publish(entry,entry.pending.length?entry.view.error:null);}void this.flush(entry);}
        } catch {for(const [,entry] of group)this.publish(entry,'Notification state could not sync. Try refreshing.');}
      }
    } finally {this.reading=false;}
  }
}
