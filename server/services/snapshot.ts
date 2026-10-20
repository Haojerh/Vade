import crypto from 'node:crypto';
import {
  Id,
  ISO,
  DashboardSnapshot,
  Section,
  Graph,
  SourceMeta,
  NodeDetails,
} from '../../shared/contracts.js';
import { CommandRunner, defaultCommandRunner, CliError } from '../integrations/cli.js';
import { collectGraph } from '../integrations/orca/graph.js';
import { collectNodeDetails } from '../integrations/orca/nodeDetails.js';

interface ProjectCache {
  projectId: Id;
  runId: Id | null;
  lastSnapshot: DashboardSnapshot | null;
  lastSuccessTime: number;
  lastAccessTime: number;
  inFlight: Promise<DashboardSnapshot> | null;
  subscribers: Set<(snapshot: DashboardSnapshot) => void>;
  pollTimer: NodeJS.Timeout | null;
}

const MAX_PROJECTS = 10;
const MAX_SSE_CLIENTS = 10;
const STALE_DEADLINE_MS = 15000;

export class SnapshotManager {
  private projects = new Map<string, ProjectCache>();
  private totalSseClients = 0;
  private nodeOutputCache = new Map<string, { data: NodeDetails; expiresAt: number }>();

  constructor(private runner: CommandRunner = defaultCommandRunner) {}

  private getCacheKey(projectId: Id, runId?: Id | null): string {
    return `${projectId}::${runId ?? 'default'}`;
  }

  public getCachedSnapshot(projectId: Id, runId?: Id | null): DashboardSnapshot | null {
    return this.projects.get(this.getCacheKey(projectId, runId))?.lastSnapshot ?? null;
  }

  private evictIfNecessary(): void {
    if (this.projects.size < MAX_PROJECTS) return;
    // Evict oldest accessed project without subscribers
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, cache] of this.projects.entries()) {
      if (cache.subscribers.size === 0 && cache.lastAccessTime < oldestTime) {
        oldestTime = cache.lastAccessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const cache = this.projects.get(oldestKey);
      if (cache?.pollTimer) clearInterval(cache.pollTimer);
      this.projects.delete(oldestKey);
    }
  }

  public async getSnapshot(
    projectId: Id,
    runId?: Id | null,
    runner: CommandRunner = this.runner
  ): Promise<DashboardSnapshot> {
    const key = this.getCacheKey(projectId, runId);
    let cache = this.projects.get(key);

    if (!cache) {
      this.evictIfNecessary();
      cache = {
        projectId,
        runId: runId ?? null,
        lastSnapshot: null,
        lastSuccessTime: 0,
        lastAccessTime: Date.now(),
        inFlight: null,
        subscribers: new Set(),
        pollTimer: null,
      };
      this.projects.set(key, cache);
    }

    cache.lastAccessTime = Date.now();

    if (cache.inFlight) {
      return cache.inFlight;
    }

    const refreshPromise = (async () => {
      try {
        const { graph, meta, runtimeId, appVersion } = await collectGraph(projectId, runId, runner);
        const nowIso = new Date().toISOString();

        const isSuccess = meta.availability === 'ready' || meta.availability === 'empty';
        if (isSuccess) {
          cache.lastSuccessTime = Date.now();
          // Stable revision from graph content
          const revHash = crypto
            .createHash('sha256')
            .update(JSON.stringify(graph))
            .digest('base64url')
            .slice(0, 16);
          const revision = `rev_${revHash}`;

          meta.stale = false;

          const snapshot: DashboardSnapshot = {
            projectId,
            revision,
            generatedAt: nowIso,
            runtime: {
              data: {
                version: appVersion ?? null,
                runtimeId,
              },
              meta: {
                availability: runtimeId ? 'ready' : 'unavailable',
                observedAt: meta.observedAt,
                attemptedAt: meta.attemptedAt,
                stale: false,
                partial: false,
                issue: null,
              },
            },
            graph: {
              data: graph,
              meta,
            },
          };

          cache.lastSnapshot = snapshot;
          return snapshot;
        }

        // Collection failed or unavailable: preserve last successful graph as stale
        if (cache.lastSnapshot && cache.lastSnapshot.graph.data) {
          const preservedGraph = cache.lastSnapshot.graph.data;
          for (const n of preservedGraph.nodes) {
            n.stale = true;
            n.liveness = 'unverifiable';
          }
          const staleMeta: SourceMeta = {
            availability: 'unavailable',
            observedAt: cache.lastSnapshot.graph.meta.observedAt,
            attemptedAt: nowIso,
            stale: true,
            partial: true,
            issue: meta.issue || { code: 'RUNTIME_UNAVAILABLE', message: 'Collection failed', retryable: true },
          };

          const staleSnapshot: DashboardSnapshot = {
            projectId,
            revision: cache.lastSnapshot.revision,
            generatedAt: nowIso,
            runtime: {
              data: {
                version: cache.lastSnapshot.runtime.data?.version ?? appVersion ?? null,
                runtimeId: runtimeId ?? cache.lastSnapshot.runtime.data?.runtimeId ?? null,
              },
              meta: {
                availability: 'unavailable',
                observedAt: cache.lastSnapshot.runtime.meta.observedAt,
                attemptedAt: nowIso,
                stale: true,
                partial: true,
                issue: meta.issue,
              },
            },
            graph: {
              data: preservedGraph,
              meta: staleMeta,
            },
          };
          cache.lastSnapshot = staleSnapshot;
          return staleSnapshot;
        }

        const snapshot: DashboardSnapshot = {
          projectId,
          revision: 'rev_unavailable',
          generatedAt: nowIso,
          runtime: {
            data: {
              version: appVersion ?? null,
              runtimeId,
            },
            meta: {
              availability: 'unavailable',
              observedAt: null,
              attemptedAt: nowIso,
              stale: false,
              partial: true,
              issue: meta.issue,
            },
          },
          graph: {
            data: graph,
            meta,
          },
        };

        cache.lastSnapshot = snapshot;
        return snapshot;
      } catch (err: any) {
        if (err instanceof CliError && (err.issue.code === 'PROJECT_NOT_FOUND' || err.issue.code === 'RUN_NOT_FOUND')) {
          throw err;
        }
        if (cache.lastSnapshot && cache.lastSnapshot.graph.data) {
          const nowIso = new Date().toISOString();
          const preservedGraph = cache.lastSnapshot.graph.data;
          for (const n of preservedGraph.nodes) {
            n.stale = true;
            n.liveness = 'unverifiable';
          }
          const staleSnapshot: DashboardSnapshot = {
            ...cache.lastSnapshot,
            generatedAt: nowIso,
            graph: {
              data: preservedGraph,
              meta: {
                ...cache.lastSnapshot.graph.meta,
                attemptedAt: nowIso,
                stale: true,
                issue: err.issue || { code: 'RUNTIME_UNAVAILABLE', message: err.message, retryable: true },
              },
            },
          };
          cache.lastSnapshot = staleSnapshot;
          return staleSnapshot;
        }
        throw err;
      } finally {
        cache.inFlight = null;
      }
    })();

    cache.inFlight = refreshPromise;
    return refreshPromise;
  }

  public subscribe(
    projectId: Id,
    runId: Id | null,
    onSnapshot: (snapshot: DashboardSnapshot) => void
  ): () => void {
    if (this.totalSseClients >= MAX_SSE_CLIENTS) {
      throw new CliError('RATE_LIMITED', 'Maximum concurrent SSE connections reached (10 max)');
    }

    const key = this.getCacheKey(projectId, runId);
    let cache = this.projects.get(key);
    if (!cache) {
      this.evictIfNecessary();
      cache = {
        projectId,
        runId,
        lastSnapshot: null,
        lastSuccessTime: 0,
        lastAccessTime: Date.now(),
        inFlight: null,
        subscribers: new Set(),
        pollTimer: null,
      };
      this.projects.set(key, cache);
    }

    this.totalSseClients++;
    cache.subscribers.add(onSnapshot);
    cache.lastAccessTime = Date.now();

    // Start polling if not already started
    if (!cache.pollTimer) {
      cache.pollTimer = setInterval(async () => {
        if (cache.subscribers.size === 0) {
          if (cache.pollTimer) clearInterval(cache.pollTimer);
          cache.pollTimer = null;
          return;
        }

        try {
          const fresh = await this.getSnapshot(projectId, runId);
          // Broadcast to subscribers
          for (const cb of cache.subscribers) {
            try {
              cb(fresh);
            } catch (subscriberErr) {
              if (process.env.NODE_ENV !== 'test') {
                const msg = subscriberErr instanceof Error ? subscriberErr.message : String(subscriberErr);
                console.warn(`[SnapshotManager] Subscriber callback failed for ${projectId}: ${msg}`);
              }
            }
          }
        } catch (pollErr) {
          if (process.env.NODE_ENV !== 'test') {
            const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            console.warn(`[SnapshotManager] Background poll failed for ${projectId}: ${msg}`);
          }
        }
      }, 3000);
    }

    // Return unsubscribe function
    return () => {
      this.totalSseClients = Math.max(0, this.totalSseClients - 1);
      cache.subscribers.delete(onSnapshot);
      if (cache.subscribers.size === 0 && cache.pollTimer) {
        clearInterval(cache.pollTimer);
        cache.pollTimer = null;
      }
    };
  }

  public async getNodeDetails(
    projectId: Id,
    nodeId: Id,
    options?: { runId?: Id | null; cursor?: string | null; direction?: 'older'; limit?: number },
    runner: CommandRunner = this.runner
  ): Promise<NodeDetails> {
    const runId = options?.runId ?? null;
      const cacheKey = `${projectId}::${runId ?? 'default'}::${nodeId}::${options?.cursor ?? ''}::${options?.limit ?? 100}::${options?.direction ?? 'newer'}`;
    const cached = this.nodeOutputCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const key = this.getCacheKey(projectId, runId);
    const projectCache = this.projects.get(key);
    let preloadedGraph = projectCache?.lastSnapshot?.graph.data;

    if (preloadedGraph && !preloadedGraph.nodes.some((n) => n.id === nodeId)) {
      preloadedGraph = undefined;
    }

    if (!preloadedGraph) {
      const snap = await this.getSnapshot(projectId, runId, runner);
      preloadedGraph = snap.graph.data ?? undefined;
    }

    const details = await collectNodeDetails(projectId, nodeId, { ...options, preloadedGraph }, runner);
    this.nodeOutputCache.set(cacheKey, {
      data: details,
      expiresAt: now + 2000, // 2s cache
    });
    return details;
  }
}

export const defaultSnapshotManager = new SnapshotManager();
