import type {
  AccountProvider,
  AddProviderAccountRequest,
  AppResources,
  HealthResponse,
  InboxData,
  LocalConnectionsData,
  NotificationState,
  PrerequisitesStatus,
  ProviderAccount,
  Section,
  UpdateNotificationStateRequest,
  UsageData,
} from '../../shared/contracts';
import { handleResponse } from './http';

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch('/api/health', {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse<HealthResponse>(res);
}

export async function fetchPrerequisites(signal?: AbortSignal): Promise<PrerequisitesStatus> {
  const res = await fetch('/api/prerequisites', {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse<PrerequisitesStatus>(res);
}

export async function fetchConnections(
  signal?: AbortSignal,
  scope: 'all' | 'accounts' | 'integrations' = 'all',
  force = false,
): Promise<Section<LocalConnectionsData>> {
  return handleResponse(await fetch(`/api/connections?scope=${scope}${force ? '&refresh=1' : ''}`, { signal }));
}

export async function addProviderAccount(
  provider: AccountProvider,
  request: AddProviderAccountRequest,
  signal?: AbortSignal,
): Promise<ProviderAccount[]> {
  return handleResponse(await fetch(`/api/provider-accounts/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  }));
}

export async function selectProviderAccount(
  provider: AccountProvider,
  accountId: string,
  signal?: AbortSignal,
): Promise<ProviderAccount[]> {
  return handleResponse(await fetch(`/api/provider-accounts/${provider}/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
    signal,
  }));
}

export async function providerAccountAction(
  provider: AccountProvider,
  action: 'login' | 'delete',
  accountId: string,
  signal?: AbortSignal,
): Promise<ProviderAccount[]> {
  return handleResponse(await fetch('/api/provider-accounts/' + provider + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
    signal,
  }));
}

export async function fetchProviderAccounts(provider: AccountProvider, signal?: AbortSignal): Promise<ProviderAccount[]> {
  return handleResponse(await fetch('/api/provider-accounts/' + provider, { signal }));
}

export async function fetchUsage(signal?: AbortSignal, refresh = false): Promise<Section<UsageData>> {
  return handleResponse<Section<UsageData>>(await fetch(refresh ? '/api/usage?refresh=1' : '/api/usage', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  }));
}

export async function fetchResources(signal?: AbortSignal): Promise<AppResources> {
  return handleResponse(await fetch('/api/resources', { signal }));
}

export async function systemRequest<T>(
  path: 'computer-awake' | 'resources/details' | 'ports' | `ports/${string}/stop`,
  value?: object,
  signal?: AbortSignal,
): Promise<T> {
  return handleResponse(await fetch(`/api/${path}`, {
    signal,
    ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}),
  }));
}

export async function speechRequest<T>(path: string, value?: object, signal?: AbortSignal): Promise<T> {
  return handleResponse(await fetch(`/api/speech/${path}`, {
    signal,
    ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}),
  }));
}

export async function fetchInbox(signal?: AbortSignal): Promise<Section<InboxData>> {
  return handleResponse<Section<InboxData>>(await fetch('/api/inbox', {
    headers: { Accept: 'application/json' },
    signal,
  }));
}

export async function fetchNotificationStates(scopes: string[]): Promise<{ states: Record<string, NotificationState> }> {
  return handleResponse(await fetch('/api/notifications/state?' + new URLSearchParams({ scopes: JSON.stringify(scopes) }), {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  }));
}

export async function updateNotificationState(request: UpdateNotificationStateRequest): Promise<NotificationState> {
  return handleResponse(await fetch('/api/notifications/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10000),
  }));
}
