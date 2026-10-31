import type { DeploymentInclusionProofV1 } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  buildDeploymentWaitProjection,
  type DeploymentWaitProjectionBuildInput,
} from '../domains/runtime-deployment/DeploymentWaitProjection.js';
import { migrateStoredProjectPath } from '../utils/persistent-project-path.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface DeploymentWaitProjectionRouteDeps {
  readonly threadStore: Pick<
    IThreadStore,
    'listByProject' | 'hasByProject' | 'listProjectCandidates' | 'listCandidates' | 'list'
  >;
  readonly taskStore: Pick<ITaskStore, 'listByKind' | 'listDeploymentWaitProjectionCandidates'>;
  readonly observeDeployment: DeploymentWaitProjectionBuildInput['observeDeployment'];
  readonly candidateSubjectRef?: string;
  readonly readCandidate: () => Promise<{ readonly revision: string; readonly observedAt: number } | null>;
  readonly proveCandidateInclusion: (
    targetRevision: string,
    candidateRevision: string,
  ) => Promise<DeploymentInclusionProofV1 | null>;
}

const querySchema = z.union([
  z.object({ projectPath: z.string().min(1).max(4096) }).strict(),
  z.object({ scope: z.literal('all') }).strict(),
]);

function canProjectThread(thread: Thread, userId: string): boolean {
  return thread.createdBy === 'system' || thread.createdBy === userId;
}

export function registerDeploymentWaitProjectionRoutes(
  app: FastifyInstance,
  deps: DeploymentWaitProjectionRouteDeps,
): void {
  // Revisions are immutable: a successful ancestry proof can serve all tabs and
  // subsequent 4s polls. Failed/unknown proofs are retried; keep the cache bounded.
  const proofCache = new Map<string, ReturnType<typeof deps.proveCandidateInclusion>>();
  const prove = (targetRevision: string, runningRevision: string) => {
    const key = JSON.stringify([targetRevision, runningRevision]);
    let pending = proofCache.get(key);
    if (pending) {
      proofCache.delete(key);
      proofCache.set(key, pending);
      return pending;
    }
    pending = deps.proveCandidateInclusion(targetRevision, runningRevision);
    proofCache.set(key, pending);
    if (proofCache.size > 128) {
      const oldest = proofCache.keys().next().value;
      if (oldest) proofCache.delete(oldest);
    }
    void pending.then(
      (proof) => {
        if (!proof) proofCache.delete(key);
      },
      () => proofCache.delete(key),
    );
    return pending;
  };
  app.get<{ Querystring: { projectPath?: string; scope?: 'all' } }>(
    '/api/runtime-deployment/waits',
    async (request, reply) => {
      const userId = resolveUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required', code: 'AUTH_REQUIRED' };
      }
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid project selector', code: 'INVALID_REQUEST' };
      }
      const all = 'scope' in parsed.data;
      const projectPath = 'projectPath' in parsed.data ? await migrateStoredProjectPath(parsed.data.projectPath) : null;
      if (!all && !projectPath) {
        reply.status(404);
        return { error: 'Project not found', code: 'PROJECT_NOT_FOUND' };
      }
      const candidates = await (deps.taskStore.listDeploymentWaitProjectionCandidates?.() ??
        deps.taskStore.listByKind('work'));
      const candidateIds = [...new Set(candidates.map((task) => task.threadId))];
      const sparse = deps.threadStore.listProjectCandidates && deps.threadStore.hasByProject;
      const visibleThreads = all
        ? deps.threadStore.listCandidates
          ? await deps.threadStore.listCandidates(userId, candidateIds)
          : await deps.threadStore.list(userId)
        : sparse
          ? await deps.threadStore.listProjectCandidates!(userId, projectPath!, candidateIds)
          : await deps.threadStore.listByProject(userId, projectPath!);
      const threads = visibleThreads.filter(
        (thread) => (all || thread.projectPath === projectPath) && canProjectThread(thread, userId),
      );
      if (!all && threads.length === 0 && (!sparse || !(await deps.threadStore.hasByProject?.(userId, projectPath!)))) {
        reply.status(404);
        return { error: 'Project not found', code: 'PROJECT_NOT_FOUND' };
      }
      const visibleThreadIds = new Set(threads.map((thread) => thread.id));
      const tasks = candidates.filter(
        (task) => visibleThreadIds.has(task.threadId) && (task.userId === undefined || task.userId === userId),
      );
      const observationCache = new Map<string, ReturnType<typeof deps.observeDeployment>>();
      const observe = (deploymentId: string) => {
        let pending = observationCache.get(deploymentId);
        if (!pending) {
          pending = deps.observeDeployment({ deploymentId });
          observationCache.set(deploymentId, pending);
        }
        return pending;
      };
      const candidate = await deps.readCandidate();
      const projection = await buildDeploymentWaitProjection({
        projectPath: projectPath ?? '',
        tasks,
        threadTitles: new Map(threads.map((thread) => [thread.id, thread.title ?? null])),
        observeDeployment: async ({ deploymentId, targetRevision }) => {
          const observation = await observe(deploymentId);
          if (!observation) return null;
          const { inclusionProof: _ignoredProof, ...base } = observation;
          if (!targetRevision || !base.runningRevision) return base;
          const proof = await prove(targetRevision, base.runningRevision);
          return proof ? { ...base, inclusionProof: proof } : base;
        },
        candidate: candidate
          ? {
              ...candidate,
              ...(deps.candidateSubjectRef ? { subjectRef: deps.candidateSubjectRef } : {}),
              proveInclusion: (targetRevision) => prove(targetRevision, candidate.revision),
            }
          : null,
      });
      const paths = new Map(threads.map((thread) => [thread.id, thread.projectPath]));
      return all
        ? {
            ...projection,
            scope: 'all',
            projectPath: null,
            items: projection.items.map((item) => ({ ...item, projectPath: paths.get(item.threadId) ?? 'default' })),
          }
        : projection;
    },
  );
}
