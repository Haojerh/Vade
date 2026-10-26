import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { UpdateNotificationStateRequest } from '../../../shared/contracts';
import { fetchNotificationStates, updateNotificationState } from '../../api/client';
import { NotificationClient } from './notificationClient';
const client=new NotificationClient({read:fetchNotificationStates,write:updateNotificationState});
const empty={state:null,error:null};
let leases=0,timer:ReturnType<typeof setInterval>|undefined,scheduled=false;
const refresh=()=>{if(document.hidden||scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(leases)void client.refresh();});};
const seeded=new Set<string>();
export function changeNotifications(request: UpdateNotificationStateRequest) { return client.update(request).catch(()=>{/* The shared snapshot reports errors and retries additive actions. */}); }
export function retryNotifications(scope: string) { void client.retry(scope); }
export function useSharedNotifications(
  scope: string | null,
  legacy?: ()=>UpdateNotificationStateRequest['legacy']|undefined,
  legacyKey?: readonly unknown[],
) {
  const subscribe=useCallback((listener:()=>void)=>{
    if(!scope)return()=>{};
    const off=client.subscribe(scope,listener);
    if(++leases===1){timer=setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);window.addEventListener('focus',refresh);}
    refresh();
    return()=>{off();if(--leases===0){clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('focus',refresh);}};
  },[scope]);
  const get=useCallback(()=>scope?client.snapshot(scope):empty,[scope]);
  const snapshot=useSyncExternalStore(subscribe,get,()=>empty);
  useEffect(()=>{if(!scope||seeded.has(scope))return;seeded.add(scope);const state=legacy?.();if(state&&Object.values(state).some(ids=>ids?.length))void changeNotifications({scope,action:'import',legacy:state});},[scope,legacy,legacyKey]);
  return snapshot;
}
