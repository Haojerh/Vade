import { Inventory, Project, SourceMeta } from '../../../shared/contracts.js';
import { runOrca, CommandRunner, defaultCommandRunner } from '../cli.js';
import { hashId } from './utils.js';
import { globalSourceMaps } from './state.js';

function normalizeProjectKind(kind: unknown, fallback: Project['kind'] = 'unknown'): Project['kind'] {
  if (kind === 'git') return 'git';
  if (kind === 'folder') return 'folder';
  return fallback;
}

function indexProjectRepo(projectsByRepoId: Map<string, Project[]>, repoId: string, proj: Project): void {
  const existing = projectsByRepoId.get(repoId);
  if (existing) {
    if (!existing.includes(proj)) existing.push(proj);
  } else {
    projectsByRepoId.set(repoId, [proj]);
  }
}

// 1. Fetch project inventory
export async function collectInventory(
  runner: CommandRunner = defaultCommandRunner
): Promise<{ inventory: Inventory; meta: SourceMeta; runtimeId: string | null; appVersion: string | null }> {
  const attemptedAt = new Date().toISOString();
  let runtimeId: string | null = null;
  let appVersion: string | null = globalSourceMaps.observedAppVersion;
  let partial = false;

  try {
    const [projectListRes, setupsRes, repoListRes, statusRes] = await Promise.allSettled([
      runOrca<any>(['project', 'list', '--json'], runner),
      runOrca<any>(['project', 'setups', '--json'], runner),
      runOrca<any>(['repo', 'list', '--json'], runner),
      runOrca<any>(['status', '--json'], runner),
    ]);

    if (statusRes.status === 'fulfilled') {
      const sResult = statusRes.value.result;
      const ver = sResult?.runtime?.appVersion;
      if (typeof ver === 'string') {
        appVersion = ver;
        globalSourceMaps.observedAppVersion = ver;
      }
      runtimeId = runtimeId || sResult?.runtime?.runtimeId || statusRes.value._meta?.runtimeId || null;
    }

    const allSourcesFailed =
      projectListRes.status === 'rejected' &&
      setupsRes.status === 'rejected' &&
      repoListRes.status === 'rejected';

    if (allSourcesFailed) {
      const failureMsg =
        (projectListRes.status === 'rejected' && projectListRes.reason?.message) || 'All inventory sources failed';
      return {
        inventory: { projects: [] },
        meta: {
          availability: 'unavailable',
          observedAt: null,
          attemptedAt,
          stale: false,
          partial: true,
          issue: {
            code: 'RUNTIME_UNAVAILABLE',
            message: failureMsg,
            retryable: true,
          },
        },
        runtimeId,
        appVersion,
      };
    }

    const sourceProjectMap = new Map<string, Project>();
    const projectsByRepoId = new Map<string, Project[]>();

    if (projectListRes.status === 'fulfilled') {
      runtimeId = projectListRes.value._meta?.runtimeId ?? null;
      const rawProjects = projectListRes.value.result?.projects ?? [];
      for (const p of rawProjects) {
        if (!p.id) continue;
        const repoIds = Array.isArray(p.sourceRepoIds) ? [...p.sourceRepoIds] : [];
        const proj: Project = {
          id: hashId('proj', p.id),
          name: p.displayName || p.id,
          kind: normalizeProjectKind(p.kind),
          sourceProjectId: p.id,
          repoIds,
          paths: [],
          hostIds: [],
        };
        sourceProjectMap.set(p.id, proj);
        for (const repoId of repoIds) {
          indexProjectRepo(projectsByRepoId, repoId, proj);
        }
      }
    } else {
      partial = true;
    }

    if (setupsRes.status === 'fulfilled') {
      runtimeId = runtimeId || setupsRes.value._meta?.runtimeId || null;
      const rawSetups = setupsRes.value.result?.setups || setupsRes.value.result || [];
      const setupsList = Array.isArray(rawSetups) ? rawSetups : [];
      for (const s of setupsList) {
        if (!s.projectId) continue;
        const existingProj = sourceProjectMap.get(s.projectId);
        if (existingProj) {
          if (s.path && !existingProj.paths.includes(s.path)) existingProj.paths.push(s.path);
          if (s.hostId && !existingProj.hostIds.includes(s.hostId)) existingProj.hostIds.push(s.hostId);
          if (s.repoId && !existingProj.repoIds.includes(s.repoId)) {
            existingProj.repoIds.push(s.repoId);
            indexProjectRepo(projectsByRepoId, s.repoId, existingProj);
          }
          continue;
        }

        const newProj: Project = {
          id: hashId('proj', s.projectId),
          name: s.displayName || s.projectId,
          kind: normalizeProjectKind(s.kind),
          sourceProjectId: s.projectId,
          repoIds: s.repoId ? [s.repoId] : [],
          paths: s.path ? [s.path] : [],
          hostIds: s.hostId ? [s.hostId] : [],
        };
        sourceProjectMap.set(s.projectId, newProj);
        if (s.repoId) {
          indexProjectRepo(projectsByRepoId, s.repoId, newProj);
        }
      }
    }

    if (repoListRes.status === 'fulfilled') {
      runtimeId = runtimeId || repoListRes.value._meta?.runtimeId || null;
      const rawRepos = repoListRes.value.result?.repos || [];
      for (const r of rawRepos) {
        if (!r.id) continue;
        const matchedProjects = projectsByRepoId.get(r.id);
        if (matchedProjects && matchedProjects.length > 0) {
          if (r.path) {
            for (const proj of matchedProjects) {
              if (!proj.paths.includes(r.path)) proj.paths.push(r.path);
            }
          }
          continue;
        }

        const sourceProjectId = `repo:${r.id}`;
        const newProj: Project = {
          id: hashId('proj', sourceProjectId),
          name: r.displayName || r.id,
          kind: normalizeProjectKind(r.kind, 'folder'),
          sourceProjectId,
          repoIds: [r.id],
          paths: r.path ? [r.path] : [],
          hostIds: ['local'],
        };
        sourceProjectMap.set(sourceProjectId, newProj);
        indexProjectRepo(projectsByRepoId, r.id, newProj);
      }
    }

    const projects: Project[] = [];
    for (const p of sourceProjectMap.values()) {
      projects.push(p);
      globalSourceMaps.projectSourceMap.set(p.id, {
        sourceId: p.sourceProjectId || p.id,
        repoIds: p.repoIds,
        paths: p.paths,
      });
    }

    const observedAt = new Date().toISOString();
    return {
      inventory: { projects },
      meta: {
        availability: projects.length > 0 ? 'ready' : 'empty',
        observedAt,
        attemptedAt,
        stale: false,
        partial,
        issue: null,
      },
      runtimeId,
      appVersion,
    };
  } catch (err: any) {
    return {
      inventory: { projects: [] },
      meta: {
        availability: 'unavailable',
        observedAt: null,
        attemptedAt,
        stale: false,
        partial: true,
        issue: {
          code: err.issue?.code || 'RUNTIME_UNAVAILABLE',
          message: err.message || 'Failed to collect inventory',
          retryable: true,
        },
      },
      runtimeId,
      appVersion,
    };
  }
}
