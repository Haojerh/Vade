export type AgentView = 'chat' | 'terminal';
const key = 'vade:agent-initial-view';
export function readAgentView(): AgentView { try { return localStorage.getItem(key)==='chat'?'chat':'terminal'; } catch { return 'terminal'; } }
export function writeAgentView(value: AgentView) { try { localStorage.setItem(key,value); } catch { /* Keep the current selection in memory. */ } }
