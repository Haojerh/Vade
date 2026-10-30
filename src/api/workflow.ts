import type {
  OrganizationConfig,
  WorkflowModel,
  WorkflowProvider,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowSetupStatus,
} from '../../shared/contracts';
import { handleResponse } from './http';

export async function workflowRequest<T>(path: string, value?: object, signal?: AbortSignal): Promise<T> {
  return handleResponse(await fetch(`/api/workflow/${path}`, {
    ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}),
    signal,
  }));
}

export const fetchOrganization = (signal?: AbortSignal) => workflowRequest<OrganizationConfig>('config', undefined, signal);
export const saveOrganization = (config: OrganizationConfig) => workflowRequest<OrganizationConfig>('config', config);
export const fetchWorkflowSetup = (signal?: AbortSignal) => workflowRequest<WorkflowSetupStatus>('setup', undefined, signal);
export const fetchWorkflowModels = (provider: WorkflowProvider, signal?: AbortSignal) =>
  workflowRequest<WorkflowModel[]>(`models?provider=${encodeURIComponent(provider)}`, undefined, signal);
export const fetchWorkflowRunSummaries = (signal?: AbortSignal) =>
  workflowRequest<WorkflowRunSummary[]>('runs?summary=1', undefined, signal);
export const fetchWorkflowRunDetails = (id: string, signal?: AbortSignal) =>
  workflowRequest<WorkflowRun>(`runs/${encodeURIComponent(id)}`, undefined, signal);
export const cancelWorkflowRun = (id: string) =>
  workflowRequest<{ ok: boolean }>(`runs/${encodeURIComponent(id)}/cancel`, {});
