import type { InboxItem, Node } from '../../../shared/contracts';

export type CardStatus = 'todo' | 'pending' | 'completed' | 'failed';
export interface KanbanCard {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  files: File[];
  status: CardStatus;
  createdAt: string;
  assignment?: { nodeId: string; label: string; runId: string | null; sentAt: string; sawWorking: boolean };
  error?: string;
}
export const KANBAN_DRAG_TYPE = 'application/orca-kanban-card';
export function buildCardPrompt(card: KanbanCard): string {
  return `${card.status === 'failed' ? 'Please fix this failed task' : 'Please implement this task'}: ${card.title}\n\n${card.prompt}`;
}
export function createCardId(): string {
  // getRandomValues is also available on local HTTP, unlike randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Fresh, explicit agent results also cover work completed between polling ticks. */
export function observeCardResults(card: KanbanCard, results: InboxItem[]): KanbanCard {
  if (card.status !== 'pending' || !card.assignment) return card;
  const result = results.filter(item => item.source === 'agent' && item.projectId === card.projectId
    && item.nodeId === card.assignment!.nodeId && Date.parse(item.at) > Date.parse(card.assignment!.sentAt))
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  return result ? { ...card, status: result.outcome === 'failed' || result.outcome === 'interrupted' ? 'failed' : 'completed', error: result.outcome === 'interrupted' ? 'The assigned workflow was interrupted.' : undefined } : card;
}

/** Completion requires a fresh working cycle, never the agent's pre-send result. */
export function observeCard(card: KanbanCard, nodes: Node[]): KanbanCard {
  if (card.status !== 'pending' || !card.assignment) return card;
  const node = nodes.find(node => node.id === card.assignment!.nodeId);
  if (!node || node.stale) return card;
  // An orchestrator's provider turn may end while its workflow is still waiting on workers.
  // Only the explicit workflow result in Inbox can settle this assignment.
  if (node.workflow?.role === 'orchestrator') return card;
  if (node.state === 'working' && !card.assignment.sawWorking) {
    return { ...card, error: undefined, assignment: { ...card.assignment, sawWorking: true } };
  }
  if (!card.assignment.sawWorking) return card;
  if (node.state === 'completed' || node.state === 'failed') {
    return { ...card, status: node.state, error: undefined };
  }
  return card;
}

export function assignmentProblem(card: KanbanCard, node: Node, cards: KanbanCard[]): string | null {
  if (card.status !== 'todo' && card.status !== 'failed') return 'Only To-do or Failed cards can be assigned.';
  if (!['agent', 'orchestrator'].includes(node.kind) || node.liveness !== 'live' || node.stale) return 'Choose a connected agent with fresh status.';
  if (node.workflow) return 'This agent belongs to an active workflow. Wait for it to finish or cancel the run.';
  if (['working', 'waiting', 'blocked'].includes(node.state)) return 'This agent is busy. Choose an idle agent.';
  if (cards.some(other => other.status === 'pending' && other.assignment?.nodeId === node.id)) return 'This agent already has a pending board task.';
  return null;
}
