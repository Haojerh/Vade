// Presentation only. Persisted backend delivery fences remain authoritative.
const dismissed = new Set<string>();
export const handoffNoticeKey = (projectId: string, nodeId: string, sourceId: string) => JSON.stringify([projectId, nodeId, sourceId]);
export const handoffNoticeDismissed = (key: string) => dismissed.has(key);
export function dismissHandoffNotice(key: string): void {
  if (dismissed.size >= 200) dismissed.delete(dismissed.values().next().value!);
  dismissed.add(key);
}
