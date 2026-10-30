import type { Id, ISO, Section } from './common.js';

export type GitHubActivity = 'commits' | 'prs' | 'issues';
export type GitHubQuery = (
  | { scope: 'general' }
  | { scope: 'worktree'; nodeId: Id }
) & { activity?: GitHubActivity; page?: number };

export interface GitHubScope {
  kind: 'general' | 'worktree';
  nodeId: Id | null;
  branch: string | null;
  commits: 'default-branch' | 'branch' | 'unavailable';
  pullRequests: 'repository' | 'head-branch' | 'unavailable';
  issues: 'repository';
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: string | null;
  updatedAt: ISO | null;
  mergedAt: ISO | null;
  headRef: string | null;
  baseRef: string | null;
}

export interface Commit {
  sha: string;
  message: string;
  url: string;
  author: string | null;
  committedAt: ISO | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  author: string | null;
  updatedAt: ISO | null;
  labels: string[];
}

export interface GitHubData {
  pagination?: Record<GitHubActivity, { nextPage: number | null }>;
  projectKind?: 'git' | 'folder' | 'unknown';
  repository: {
    owner: string;
    name: string;
    url: string;
    remoteName: string | null;
  } | null;
  auth: 'available' | 'required' | 'unknown';
  scope: GitHubScope;
  pullRequests: Section<PullRequest[]>;
  commits: Section<Commit[]>;
  issues: Section<GitHubIssue[]>;
}

export interface CommitGraphEntry {
  sha: string;
  parents: string[];
  message: string;
  author: string;
  committedAt: string;
  refs: string[];
}
export interface CommitGraphData { commits: CommitGraphEntry[]; truncated: boolean }
export interface CommitFiles { sha: string; files: { path: string; status: string }[]; truncated: boolean; excluded: number }

export interface SourceFile {
  path: string;
  index: string;
  worktree: string;
  added: number | null;
  removed: number | null;
  stagedAdded?: number | null;
  stagedRemoved?: number | null;
  workingAdded?: number | null;
  workingRemoved?: number | null;
}
export interface SourceStatus {
  worktreeId: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: SourceFile[];
  version: string;
  refs: string[];
  base: string | null;
  canCreatePr: boolean;
  conflicts: boolean;
  truncated: boolean;
  excluded: number;
}
export type SourceAction = 'stage' | 'unstage' | 'discard' | 'commit' | 'push' | 'forcePush' | 'pull' | 'fetch' | 'fastForward' | 'sync' | 'rebase' | 'publish' | 'createPr';
export interface SourceActionRequest { worktreeId: string; action: SourceAction; version: string; paths?: string[]; message?: string; base?: string; title?: string; body?: string }
export interface SourceActionResponse { ok: true; url?: string }
export interface SourceReviewQuery { worktreeId: string; base?: string }
export interface SourceDiff { path: string; original: string; modified: string; binary: boolean; reason?: string }

// Standalone workspace explorer. Paths are relative to a discovered worktree.
export interface WorkspaceEntry { path: string; name: string; directory: boolean; symlink: boolean; status: string | null }
export interface WorkspaceRoot { id: string; label: string; path: string; branch: string | null }
export interface WorkspaceListing { entries: WorkspaceEntry[]; truncated: boolean; gitError: string | null }
export interface WorkspaceSearchOptions { matchCase?: boolean; wholeWord?: boolean; regex?: boolean; include?: string; exclude?: string; showDotfiles?: boolean; showIgnored?: boolean }
export interface WorkspaceSearch { matches: { path: string; line?: number; preview?: string; status?: string | null; ranges?: [number, number][] }[]; truncated: boolean }
export interface WorkspaceFile { path: string; text: string; version: string; original: string | null; gitError: string | null; git?: boolean; preview?: { kind: 'image' | 'binary'; size: number; mime: string | null; dataUrl?: string } }
export interface WorkspaceFileActionRequest { worktreeId: string; action: 'file' | 'folder' | 'duplicate' | 'copy' | 'rename' | 'trash' | 'restore'; path: string; destination?: string; version?: string; restoreId?: string }
export interface WorkspaceFileActionResult { path: string; restoreId?: string }
export interface WorkspaceFileStat { version: string; directory: boolean }
export interface SaveWorkspaceFileRequest { worktreeId: string; path: string; text: string; version: string }
