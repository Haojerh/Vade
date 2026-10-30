import type { AdeProvider } from './agents.js';

export const WORKFLOW_CONFIRMATION_MESSAGE = 'Workflow enabled, confirm to continue implementation with workflow or disable settings yourself';

/** Saved execution graph. Requested launch options are separate from observed agent metadata. */
export type WorkflowProvider = Exclude<AdeProvider, 'terminal'>;

export interface OrganizationNode {
  id: string;
  title: string;
  prompt: string;
  provider: WorkflowProvider;
  model: string | null;
  effort: string | null;
  x: number;
  y: number;
}

export interface OrganizationConfig {
  version: 1;
  enabled: boolean;
  isolatedWorktrees: boolean;
  closeWorkersOnCompletion?: boolean;
  removeWorktreesOnCompletion?: boolean;
  orchestratorPosition?: { x: number; y: number };
  nodes: OrganizationNode[];
  edges: { source: string; target: string }[];
}

export interface AdhocOrchestrationRequest {
  request: string;
  isolatedWorktrees?: boolean;
  nodes: Omit<OrganizationNode, 'x' | 'y'>[];
  edges?: OrganizationConfig['edges'];
}

export interface WorkflowModel {
  id: string;
  label: string;
  efforts: string[];
  effortModels?: Record<string, string>;
  contextWindow?: number;
}

export interface WorkflowSetupStatus {
  ready: boolean;
  cli: boolean;
  skill: boolean;
  cliSkill: boolean;
  cliPath: string;
  version: string;
  error: string | null;
}

export interface WorkflowStep {
  nodeId: string;
  state: 'pending' | 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped';
  sessionId: string | null;
  stream: string | null;
  result: string | null;
  delivery: 'not-sent' | 'submitted' | 'uncertain';
  task?: string;
}

export interface WorkflowStream {
  id: string;
  title: string;
  nodes: string[];
  worktreeId: string | null;
  integrated: boolean;
}

export interface WorkflowRun {
  mode?: 'configured' | 'adhoc';
  id: string;
  projectId: string;
  orchestratorId: string;
  worktreeId: string;
  originalRequest: string;
  createdAt: string;
  updatedAt: string;
  state: 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  config: OrganizationConfig;
  steps: WorkflowStep[];
  streams: WorkflowStream[];
  baseSha: string | null;
  error: string | null;
  result: string | null;
  planReason?: string;
  integrationTreeId?: string;
  integrationPath?: string;
  integrationShas?: string[];
  messages: { id: string; from: string; to: string; text: string; at: string }[];
}

export interface WorkflowRunSummary {
  id: string;
  projectId: string;
  worktreeId: string;
  mode: 'configured' | 'adhoc';
  requestPreview: string;
  createdAt: string;
  updatedAt: string;
  state: WorkflowRun['state'];
  counts: { total: number; completed: number; running: number; pending: number; failed: number; skipped: number };
  providers: WorkflowProvider[];
  hasError: boolean;
}
