import type { Id, ISO, SourceMeta } from './common.js';

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: ISO | null;
}

export interface ProviderUsage {
  provider: string;
  label: string;
  windows: UsageWindow[];
  buckets: UsageWindow[];
  meta: SourceMeta;
}

export interface UsageData {
  providers: ProviderUsage[];
  pendingProviders?: string[];
}

export interface LocalConnection {
  id: 'github' | 'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh' | 'freebuff';
  label: string;
  installed: boolean;
  connected: boolean | null;
  message: string;
  installUrl: string;
  loginCommand: string;
  accounts?: ProviderAccount[];
}

export type AccountProvider = 'codex' | 'claude' | 'opencode';
export interface ProviderAccount {
  id: string;
  label: string;
  active: boolean;
  detected: boolean | null;
  signIn?: ProviderSignIn;
  loginCommand: string;
}
export interface ProviderSignIn { state: 'pending' | 'complete' | 'failed'; url?: string }
export interface AddProviderAccountRequest { label: string }
export interface SelectProviderAccountRequest { accountId: string }

export interface LocalConnectionsData {
  host: 'Windows' | 'macOS' | 'Linux';
  connections: LocalConnection[];
}

export interface AppResources {
  memoryBytes: number;
  scope: 'desktop-app' | 'backend' | 'desktop-tree' | 'backend-tree';
  processCount?: number;
  observedAt: ISO;
}
export interface ResourceProcess { pid: number; parent: number; name: string; memoryBytes: number; privateBytes: number | null; cpuPercent: number | null }
export interface ResourceDetails { observedAt: string; totalBytes: number; groups: { id: string; label: string; processes: ResourceProcess[] }[] }
export interface ComputerAwakeStatus { mode: 'on' | 'agent' | 'off'; active: boolean; error: string | null }
export interface WorkspacePort { id: string; port: number; address: string; pid: number; process: string; projectId: string | null; project: string | null; canKill: boolean }
export interface WorkspacePorts { observedAt: string; ports: WorkspacePort[]; error: string | null }

export interface HealthResponse {
  status: 'ok';
  readOnly: boolean;
}

export interface PrerequisitesStatus {
  runtime?: 'ade' | 'orca';
  git?: boolean;
  orcaApp: boolean;
  orcaAppOpen: boolean;
  orcaCli: boolean;
  orchestrationSkill: boolean;
  orcaCliSkill: boolean;
  ready: boolean;
  version?: string | null;
  issues?: string[];
}

/** Bounded cross-project observations; handling is shared by the local backend. */
export interface InboxItem {
  id: Id;
  nodeId: Id | null;
  runId: Id | null;
  projectId: Id;
  projectName: string;
  entityId: string;
  title: string;
  outcome: 'succeeded' | 'failed' | 'completed' | 'interrupted' | 'waiting';
  at: ISO;
  source: 'agent' | 'task' | 'turn' | 'attention';
}

export interface InboxData { items: InboxItem[] }
export interface NotificationState {
  initialized: boolean;
  revision: number;
  seenIds: string[];
  unreadIds: string[];
  readIds: string[];
  clearedIds: string[];
}
export interface UpdateNotificationStateRequest {
  scope: string;
  action: 'observe' | 'acknowledge' | 'clear' | 'import';
  ids?: string[];
  baseline?: boolean;
  legacy?: { seenIds?: string[]; unreadIds?: string[]; readIds?: string[]; clearedIds?: string[] };
}

/** Local speech contracts. Audio is mono float32 PCM at exactly 16 kHz. */
export interface LocalSpeechModel {
  id: string;
  label: string;
  description: string;
  sizeBytes: number;
  streaming: boolean;
  recommended?: boolean;
  status: 'missing' | 'downloading' | 'ready' | 'error';
  downloadedBytes: number;
  error?: string;
}
export interface LocalSpeechCatalog { available: boolean; reason?: string; models: LocalSpeechModel[] }
export interface SpeechAudioRequest { pcm: string; sequence: number }
export interface SpeechTranscript { text: string; interim: string }
export interface StartSpeechRequest { modelId: string }
export interface StartSpeechResponse { sessionId: string }

export interface DesktopUpdateStatus {
  state: 'unsupported' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  percent: number | null;
  checkedAt: string | null;
  message: string | null;
}

export interface PhoneConnectionSettings { enabled: boolean; origin: string }
export interface PhoneSetupTerminal { projectId: string; nodeId: string; command: string }
