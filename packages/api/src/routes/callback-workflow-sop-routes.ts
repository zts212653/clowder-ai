import type { BacklogItem, CatId, TaskItem } from '@cat-cafe/shared';
import { DEVELOPMENT_SOP_STAGE_IDS, SOP_DEFINITION_IDS } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStoreContract.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { IWorkflowSopStore } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import { VersionConflictError } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import { getFeatureTagId } from './backlog-doc-import.js';
import { requireCallbackAuth, requireCallbackPrincipal } from './callback-auth-prehandler.js';
import { resolvePrincipalThread } from './callback-scope-helpers.js';

/** Thread store surface required for owner-scoped current/cross-thread resolution. */
export interface WorkflowThreadStoreLike {
  get: IThreadStore['get'];
  list: IThreadStore['list'];
}

const getWorkflowSopCallbackSchema = z.object({
  threadId: z.string().min(1).optional(),
});

const updateWorkflowSopCallbackSchema = z.object({
  backlogItemId: z.string().min(1).optional(), // F073 follow-up: now optional — server resolves via featureId
  taskId: z.string().min(1).optional(),
  featureId: z.string().min(1),
  sopDefinitionId: z.enum(SOP_DEFINITION_IDS).optional(),
  stage: z.enum(DEVELOPMENT_SOP_STAGE_IDS).optional(),
  batonHolder: z.string().min(1).optional(),
  nextSkill: z.string().nullable().optional(),
  resumeCapsule: z
    .object({
      goal: z.string().optional(),
      done: z.array(z.string()).optional(),
      currentFocus: z.string().optional(),
    })
    .optional(),
  checks: z
    .object({
      remoteMainSynced: z.enum(['attested', 'verified', 'unknown']).optional(),
      qualityGatePassed: z.enum(['attested', 'verified', 'unknown']).optional(),
      reviewApproved: z.enum(['attested', 'verified', 'unknown']).optional(),
      visionGuardDone: z.enum(['attested', 'verified', 'unknown']).optional(),
    })
    .optional(),
  expectedVersion: z.number().int().optional(),
});

/**
 * Validate that a backlog item's feature tag matches the requested featureId.
 * Checks ALL `feature:` tags — a backlog item may carry multiple (e.g. cross-feature items).
 * Tag format: `feature:f073` (lowercase).
 */
export function validateFeatureBinding(item: BacklogItem, featureId: string): boolean {
  const normalizedId = featureId.toLowerCase();
  return (item.tags ?? []).some(
    (tag) => tag.startsWith('feature:') && tag.slice('feature:'.length).toLowerCase() === normalizedId,
  );
}

type BacklogResolution =
  | { item: BacklogItem }
  | {
      error: string;
      code: string;
      status: number;
      hint?: string;
      candidates?: Array<{ id: string; projectId?: string; title?: string }>;
    };

function taskMatchesWorkflowAuthority(
  task: TaskItem,
  input: { featureId: string; threadId: string; userId: string },
): boolean {
  return (
    task.kind === 'work' &&
    task.threadId === input.threadId &&
    task.userId === input.userId &&
    task.relatedFeatureId?.toLowerCase() === input.featureId.toLowerCase()
  );
}

function backlogNotImported(featureId: string): BacklogResolution {
  return {
    error: `No backlog item found for feature "${featureId}". The feature may not have been imported into your runtime backlog yet.`,
    code: 'backlog_not_imported',
    status: 404,
    hint: 'Import the feature via Mission Hub, or create a same-user same-thread work task with explicit relatedFeatureId and retry. Provide taskId when more than one task matches.',
  };
}

async function resolveTaskBackedItem(input: {
  featureId: string;
  userId: string;
  threadId: string;
  taskId?: string;
  createdBy: CatId;
  backlogStore: IBacklogStore;
  taskStore?: ITaskStore;
}): Promise<BacklogResolution> {
  if (!input.taskStore) return backlogNotImported(input.featureId);
  const eligible = (task: TaskItem) => taskMatchesWorkflowAuthority(task, input);
  let candidates: TaskItem[];
  if (input.taskId) {
    const selected = await input.taskStore.get(input.taskId);
    if (!selected || !eligible(selected)) {
      return {
        error: `Task "${input.taskId}" is not same-user, same-thread work truth explicitly related to feature "${input.featureId}".`,
        code: 'task_backlog_source_invalid',
        status: 422,
      };
    }
    candidates = [selected];
  } else {
    candidates = (await input.taskStore.listByThread(input.threadId)).filter(eligible);
  }

  if (candidates.length > 1) {
    return {
      error: `Multiple durable tasks are explicitly related to feature "${input.featureId}". Please provide taskId.`,
      code: 'ambiguous_task_backlog_source',
      status: 409,
      candidates: candidates.map((task) => ({ id: task.id, title: task.title })),
    };
  }
  const task = candidates.at(0);
  if (!task) return backlogNotImported(input.featureId);
  const item = await input.backlogStore.ensureTaskBackedItem({
    userId: input.userId,
    taskId: task.id,
    featureId: input.featureId,
    title: task.title,
    summary: task.why,
    createdBy: input.createdBy,
  });
  return { item };
}

async function resolveThreadBoundItem(input: {
  featureId: string;
  userId: string;
  threadId: string;
  backlogStore: IBacklogStore;
  threadStore?: WorkflowThreadStoreLike;
}): Promise<BacklogResolution | undefined> {
  if (!input.threadStore) return undefined;
  const thread = await input.threadStore.get(input.threadId);
  if (!thread?.backlogItemId) return undefined;
  const boundItem = await input.backlogStore.get(thread.backlogItemId, input.userId);
  if (!boundItem) return undefined;
  if (validateFeatureBinding(boundItem, input.featureId)) return { item: boundItem };
  return {
    error: `Thread is bound to backlog item "${thread.backlogItemId}" (feature: ${getFeatureTagId(boundItem.tags ?? []) ?? 'unknown'}) which does not match requested featureId "${input.featureId}"`,
    code: 'feature_mismatch',
    status: 422,
  };
}

/**
 * Resolve featureId → backlogItemId with thread-aware priority and safety guards.
 *
 * Resolution chain:
 * 1. Thread binding (strong truth source) — if thread has a backlogItemId, use it.
 *    Mismatch → fail-closed (no fallback to scan).
 * 2. Scan user's backlog items — filter by feature tag, require unique match.
 *    Ambiguous (multiple) → fail.
 *    Single match within user's own backlog → resolve (user-scope = unambiguous).
 * 3. Zero backlog matches → materialize from exact same-user, same-thread work-task truth.
 *    Multiple exact tasks require explicit taskId; inferred detectedFeatureIds never qualify.
 */
async function resolveBacklogItem(
  featureId: string,
  userId: string,
  threadId: string,
  taskId: string | undefined,
  createdBy: CatId,
  backlogStore: IBacklogStore,
  taskStore: ITaskStore | undefined,
  threadStore: WorkflowThreadStoreLike | undefined,
): Promise<BacklogResolution> {
  // Step 1: Try thread binding (strong truth source). Stale bindings fall through.
  const threadBound = await resolveThreadBoundItem({
    featureId,
    userId,
    threadId,
    backlogStore,
    ...(threadStore ? { threadStore } : {}),
  });
  if (threadBound) return threadBound;

  // Step 2: Scan user's backlog items by feature tag
  const allItems = await backlogStore.listByUser(userId);
  const matches = allItems.filter((item) => validateFeatureBinding(item, featureId));

  if (matches.length === 0) {
    return resolveTaskBackedItem({
      featureId,
      userId,
      threadId,
      ...(taskId ? { taskId } : {}),
      createdBy,
      backlogStore,
      ...(taskStore ? { taskStore } : {}),
    });
  }

  if (matches.length === 1) {
    const match = matches.at(0);
    // If the single match has a projectId but we have no thread context to prove scope,
    // we still allow it — the user-scoped search already limits to this user's items.
    // Sol's constraint about "外项目同号候选" applies when there are multiple candidates;
    // a single match within the user's own backlog is unambiguous.
    if (match) return { item: match };
  }

  // Multiple matches — ambiguous
  return {
    error: `Multiple backlog items match feature "${featureId}". Please provide explicit backlogItemId.`,
    code: 'ambiguous_backlog_item',
    status: 409,
    candidates: matches.map((m) => ({ id: m.id, projectId: (m as { projectId?: string }).projectId })),
  };
}

export function registerCallbackWorkflowSopRoutes(
  app: FastifyInstance,
  deps: {
    workflowSopStore: IWorkflowSopStore;
    backlogStore: IBacklogStore;
    taskStore?: ITaskStore;
    threadStore?: WorkflowThreadStoreLike;
  },
): void {
  const { workflowSopStore, backlogStore, taskStore, threadStore } = deps;

  app.get('/api/callbacks/get-workflow-sop', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const parsed = getWorkflowSopCallbackSchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }
    if (!threadStore) {
      reply.status(503);
      return { error: 'Thread store not configured for workflow SOP reads' };
    }

    const threadResult = await resolvePrincipalThread(principal, parsed.data.threadId, {
      threadStore,
      accessDeniedError: 'Workflow SOP thread access denied',
    });
    if (!threadResult.ok) {
      reply.status(threadResult.statusCode);
      return { error: threadResult.error };
    }

    const thread = await threadStore.get(threadResult.threadId);
    if (!thread?.backlogItemId) {
      reply.status(404);
      return { error: 'Workflow SOP not found' };
    }
    const ownedItem = await backlogStore.get(thread.backlogItemId, principal.userId);
    if (!ownedItem) {
      reply.status(404);
      return { error: 'Workflow SOP not found' };
    }
    const workflowSop = await workflowSopStore.get(thread.backlogItemId);
    if (!workflowSop) {
      reply.status(404);
      return { error: 'Workflow SOP not found' };
    }
    return {
      threadId: threadResult.threadId,
      backlogItemId: thread.backlogItemId,
      workflowSop,
    };
  });

  app.post('/api/callbacks/update-workflow-sop', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (record.ownerAuthProvenance !== 'strict') {
      reply.status(403);
      return {
        error: 'Strict owner authentication is required for managed-work admission',
        code: 'strict_owner_auth_required',
      };
    }

    const parsed = updateWorkflowSopCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { backlogItemId: explicitBacklogItemId, taskId, featureId, ...rest } = parsed.data;

    let resolvedBacklogItemId: string;

    if (explicitBacklogItemId) {
      // Explicit path: validate item exists, belongs to user, AND feature tag matches.
      // Also check thread binding consistency — if the thread is already bound to a
      // different backlog item, fail-closed to prevent cross-board silent penetration.
      // (Unbound threads impose no constraint on explicit IDs.)
      if (threadStore) {
        const thread = await threadStore.get(record.threadId);
        if (thread?.backlogItemId && thread.backlogItemId !== explicitBacklogItemId) {
          // Only enforce binding if the bound item still exists (consistent with
          // the implicit resolver path at step 1 which falls through on stale bindings)
          const boundItem = await backlogStore.get(thread.backlogItemId, record.userId);
          if (boundItem) {
            reply.status(422);
            return {
              error: `Thread is bound to backlog item "${thread.backlogItemId}" but explicit backlogItemId "${explicitBacklogItemId}" was provided. Use the thread-bound item or update the thread binding.`,
              code: 'thread_binding_conflict',
            };
          }
          // Stale binding (item no longer exists) — treat as unbound, allow explicit ID
        }
      }

      const item = await backlogStore.get(explicitBacklogItemId, record.userId);
      if (!item) {
        reply.status(404);
        return { error: 'Backlog item not found', code: 'backlog_item_not_found' };
      }
      if (!validateFeatureBinding(item, featureId)) {
        const actualFeature = getFeatureTagId(item.tags ?? []);
        reply.status(422);
        return {
          error: `Backlog item "${explicitBacklogItemId}" has feature tag "${actualFeature ?? 'none'}" which does not match requested featureId "${featureId}"`,
          code: 'feature_mismatch',
        };
      }
      resolvedBacklogItemId = explicitBacklogItemId;
    } else {
      // Resolver path: featureId → backlogItemId
      const result = await resolveBacklogItem(
        featureId,
        record.userId,
        record.threadId,
        taskId,
        record.catId as CatId,
        backlogStore,
        taskStore,
        threadStore,
      );
      if ('error' in result) {
        reply.status(result.status);
        const response: Record<string, unknown> = { error: result.error, code: result.code };
        if (result.candidates) response.candidates = result.candidates;
        if ('hint' in result) response.hint = (result as { hint?: string }).hint;
        return response;
      }
      resolvedBacklogItemId = result.item.id;
    }

    // Extract updatedBy from invocation context (cat's unique handle)
    const updatedBy = record.catId ?? 'unknown';

    try {
      const input = {
        ...(rest.stage !== undefined ? { stage: rest.stage } : {}),
        ...(rest.sopDefinitionId !== undefined ? { sopDefinitionId: rest.sopDefinitionId } : {}),
        ...(rest.batonHolder !== undefined ? { batonHolder: rest.batonHolder } : {}),
        ...(rest.nextSkill !== undefined ? { nextSkill: rest.nextSkill } : {}),
        ...(rest.resumeCapsule !== undefined ? { resumeCapsule: rest.resumeCapsule } : {}),
        ...(rest.checks !== undefined ? { checks: rest.checks } : {}),
        ...(rest.expectedVersion !== undefined ? { expectedVersion: rest.expectedVersion } : {}),
      } as import('@cat-cafe/shared').UpdateWorkflowSopInput;

      const sop = await workflowSopStore.upsert(resolvedBacklogItemId, featureId, input, updatedBy, record.userId);
      return sop;
    } catch (err) {
      if (err instanceof VersionConflictError) {
        reply.status(409);
        return { error: 'Version conflict', currentState: err.currentState };
      }
      throw err;
    }
  });
}
