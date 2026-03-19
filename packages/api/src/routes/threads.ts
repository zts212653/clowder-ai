/**
 * Thread API Routes
 * POST   /api/threads     - 创建对话
 * GET    /api/threads      - 列出用户的对话
 * GET    /api/threads/:id  - 获取对话详情
 * PATCH  /api/threads/:id  - 更新标题
 * DELETE /api/threads/:id  - 删除对话
 */

import type { CatId } from '@cat-cafe/shared';
import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { TaskProgressStore } from '../domains/cats/services/agents/invocation/TaskProgressStore.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { DeliveryCursorStore } from '../domains/cats/services/stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IMemoryStore } from '../domains/cats/services/stores/ports/MemoryStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadReadStateStore } from '../domains/cats/services/stores/ports/ThreadReadStateStore.js';
import type {
  BootcampStateV1,
  IThreadStore,
  ThreadRoutingPolicyV1,
} from '../domains/cats/services/stores/ports/ThreadStore.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { getMultiMentionOrchestrator } from './callback-multi-mention-routes.js';

export interface ThreadsRoutesOptions {
  threadStore: IThreadStore;
  /** Optional: cascade delete messages when thread is deleted */
  messageStore?: IMessageStore;
  /** Optional: cascade delete tasks when thread is deleted */
  taskStore?: ITaskStore;
  /** Optional: cascade delete memory when thread is deleted */
  memoryStore?: IMemoryStore;
  /** Optional: cascade delete delivery cursors when thread is deleted */
  deliveryCursorStore?: DeliveryCursorStore;
  /** Optional: protect active invocations from thread deletion (#35) */
  invocationTracker?: InvocationTracker;
  /** #80: cascade delete streaming drafts */
  draftStore?: IDraftStore;
  /** F045: per-cat task progress snapshot store (Redis-backed when available) */
  taskProgressStore?: TaskProgressStore;
  /** F069: per-user/per-thread read state for unread badge persistence */
  readStateStore?: IThreadReadStateStore;
  /** F095 Phase C: validate backlogItemId on thread creation */
  backlogStore?: IBacklogStore;
}

/** F087: Bootcamp state Zod schema */
const bootcampPhaseSchema = z.enum([
  'phase-0-select-cat',
  'phase-1-intro',
  'phase-2-env-check',
  'phase-3-config-help',
  'phase-3.5-advanced',
  'phase-4-task-select',
  'phase-5-kickoff',
  'phase-6-design',
  'phase-7-dev',
  'phase-8-review',
  'phase-9-complete',
  'phase-10-retro',
  'phase-11-farewell',
]);
const bootcampStateSchema = z
  .object({
    v: z.literal(1),
    phase: bootcampPhaseSchema,
    leadCat: catIdSchema().optional(),
    selectedTaskId: z.string().max(50).optional(),
    envCheck: z
      .record(z.object({ ok: z.boolean(), version: z.string().optional(), note: z.string().optional() }))
      .optional(),
    advancedFeatures: z.record(z.enum(['available', 'unavailable', 'skipped'])).optional(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
  })
  .strict();

const createThreadSchema = z.object({
  /** Legacy fallback only; preferred identity source is X-Cat-Cafe-User header. */
  userId: z.string().min(1).max(100).optional(),
  title: z.string().min(1).max(200).optional(),
  projectPath: z.string().min(1).max(500).optional(),
  /** F32-b Phase 2: Thread-level cat preference (validated against catRegistry) */
  preferredCats: z.array(catIdSchema()).max(10).optional(),
  /** F095 Phase C: Pin thread on creation */
  pinned: z.boolean().optional(),
  /** F095 Phase C: Associate thread with a backlog item at creation */
  backlogItemId: z.string().min(1).max(100).optional(),
  /** F087: Initial bootcamp state */
  bootcampState: bootcampStateSchema.optional(),
});

const listThreadsSchema = z.object({
  projectPath: z.string().min(1).max(500).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  backlogItemIds: z.string().trim().min(1).max(4000).optional(),
  hasBacklogItemId: z.union([z.boolean(), z.string().trim().min(1).max(8)]).optional(),
  /** F058 Phase G: comma-separated feature IDs to match against thread titles (e.g. "f058,f042") */
  featureIds: z.string().trim().min(1).max(2000).optional(),
  /** F095 Phase D: When true, list soft-deleted threads (trash bin) instead of active threads. */
  deleted: z.union([z.boolean(), z.string().trim().min(1).max(8)]).optional(),
});

function parseOptionalBooleanQuery(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

const threadRoutingRuleSchema = z
  .object({
    avoidCats: z.array(catIdSchema()).max(10).optional(),
    preferCats: z.array(catIdSchema()).max(10).optional(),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/, 'reason must be single-line')
      .optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();

const threadRoutingPolicySchema = z
  .object({
    v: z.literal(1),
    scopes: z
      .object({
        review: threadRoutingRuleSchema.optional(),
        architecture: threadRoutingRuleSchema.optional(),
      })
      .partial()
      .optional(),
  })
  .strict();

const updateThreadSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    favorited: z.boolean().optional(),
    thinkingMode: z.enum(['debug', 'play']).optional(),
    /** F32-b Phase 2: Update thread-level cat preference. Empty array clears. */
    preferredCats: z.array(catIdSchema()).max(10).optional(),
    /** F042: Thread-level routing policy by intent/scope. null clears. */
    routingPolicy: threadRoutingPolicySchema.nullable().optional(),
    /** F092: Voice companion mode toggle. */
    voiceMode: z.boolean().optional(),
    /** F087: Update bootcamp state. null clears. */
    bootcampState: bootcampStateSchema.nullable().optional(),
  })
  .refine(
    (data) =>
      data.title !== undefined ||
      data.pinned !== undefined ||
      data.favorited !== undefined ||
      data.thinkingMode !== undefined ||
      data.preferredCats !== undefined ||
      data.routingPolicy !== undefined ||
      data.voiceMode !== undefined ||
      data.bootcampState !== undefined,
    {
      message: 'At least one field must be provided',
    },
  );

export const threadsRoutes: FastifyPluginAsync<ThreadsRoutesOptions> = async (app, opts) => {
  const { threadStore, messageStore, taskProgressStore } = opts;

  // POST /api/threads - 创建对话
  app.post('/api/threads', async (request, reply) => {
    const parseResult = createThreadSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { userId: legacyUserId, title, projectPath, preferredCats, pinned, backlogItemId } = parseResult.data;
    const userId = resolveUserId(request, { fallbackUserId: legacyUserId });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    // Validate projectPath is a real directory under allowed roots
    let thread;
    if (projectPath && projectPath !== 'default') {
      const validated = await validateProjectPath(projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid projectPath: must be an existing directory under allowed roots' };
      }
      thread = await threadStore.create(userId, title, validated);
    } else {
      thread = await threadStore.create(userId, title, projectPath);
    }

    // F32-b Phase 2: Set preferred cats if provided at creation time
    if (preferredCats && preferredCats.length > 0) {
      await threadStore.updatePreferredCats(thread.id, preferredCats as CatId[]);
    }

    // F095 Phase C: Pin thread on creation
    if (pinned) {
      await threadStore.updatePin(thread.id, true);
    }

    // F095 Phase C: Link backlog item on creation (validate existence first)
    if (backlogItemId) {
      if (opts.backlogStore) {
        const item = await opts.backlogStore.get(backlogItemId, userId);
        if (!item) {
          reply.status(400);
          return { error: 'Invalid backlogItemId: backlog item not found or not owned by user' };
        }
      }
      await threadStore.linkBacklogItem(thread.id, backlogItemId);
    }

    // Re-fetch if any post-create mutations applied
    if ((preferredCats && preferredCats.length > 0) || pinned || backlogItemId) {
      thread = (await threadStore.get(thread.id)) ?? thread;
    }

    // F087: Set bootcamp state if provided at creation time
    const { bootcampState } = parseResult.data;
    if (bootcampState) {
      await threadStore.updateBootcampState(thread.id, bootcampState as BootcampStateV1);
      thread = (await threadStore.get(thread.id)) ?? thread;
    }

    reply.status(201);
    return thread;
  });

  // GET /api/threads - 列出用户的对话
  app.get('/api/threads', async (request, reply) => {
    const parseResult = listThreadsSchema.safeParse(request.query);
    if (!parseResult.success) {
      return { threads: [] };
    }

    const {
      projectPath,
      q,
      backlogItemIds,
      hasBacklogItemId: hasBacklogItemIdRaw,
      featureIds,
      deleted: deletedRaw,
    } = parseResult.data;
    const hasBacklogItemId = parseOptionalBooleanQuery(hasBacklogItemIdRaw);
    const showDeleted = parseOptionalBooleanQuery(deletedRaw);
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) return { threads: [] };

    // F095 Phase D: Return soft-deleted threads when deleted=true
    if (showDeleted) {
      const deletedThreads = await threadStore.listDeleted(userId);
      return { threads: deletedThreads };
    }

    let threads = projectPath ? await threadStore.listByProject(userId, projectPath) : await threadStore.list(userId);

    // F058 Phase G: Match threads by feature IDs in titles
    if (featureIds) {
      const ids = featureIds
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => /^f\d{2,4}$/i.test(id));
      if (ids.length > 50) {
        reply.status(400);
        return { error: 'Too many featureIds (max 50)' };
      }
      if (ids.length > 0) {
        // Build fuzzy regex per feature ID:
        // f066 matches: f066, f66, F 066, feat66, feat 066, feature66, feature 066, etc.
        const patternsByCanonical = new Map<string, RegExp>();
        for (const fid of ids) {
          const num = Number.parseInt(fid.slice(1), 10);
          // (?:f(?:eat(?:ure)?)?) matches: f, feat, feature
          // \s* allows optional space between prefix and number
          // 0* allows optional leading zeros
          // (?!\d) prevents matching f661 when looking for f66
          patternsByCanonical.set(fid.toUpperCase(), new RegExp(`(?:f(?:eat(?:ure)?)?)\\s*0*${num}(?!\\d)`, 'i'));
        }
        const threadsByFeature: Record<
          string,
          Array<{ id: string; title: string | null; lastActiveAt: number; participants: CatId[] }>
        > = {};
        for (const thread of threads) {
          const title = thread.title ?? '';
          for (const [canonical, pattern] of patternsByCanonical) {
            if (pattern.test(title)) {
              const arr = threadsByFeature[canonical] ?? [];
              arr.push({
                id: thread.id,
                title: thread.title,
                lastActiveAt: thread.lastActiveAt,
                participants: thread.participants,
              });
              threadsByFeature[canonical] = arr;
            }
          }
        }
        return { threadsByFeature };
      }
    }

    const requestedBacklogIds = backlogItemIds
      ? new Set(
          backlogItemIds
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        )
      : null;

    if (requestedBacklogIds && requestedBacklogIds.size > 50) {
      reply.status(400);
      return { error: 'Too many backlogItemIds (max 50)' };
    }

    if (requestedBacklogIds && requestedBacklogIds.size > 0) {
      threads = threads.filter((thread) => {
        const linkedBacklogId = thread.backlogItemId;
        return !!linkedBacklogId && requestedBacklogIds.has(linkedBacklogId);
      });
    } else if (hasBacklogItemId === true) {
      threads = threads.filter((thread) => !!thread.backlogItemId);
    }

    if (q) {
      const needle = q.toLowerCase();
      threads = threads.filter((thread) => {
        const title = (thread.title ?? '').toLowerCase();
        const fallback = (thread.id === 'default' ? '大厅' : '未命名对话').toLowerCase();
        const project = (thread.projectPath ?? '').toLowerCase();
        return title.includes(needle) || fallback.includes(needle) || project.includes(needle) || thread.id === q;
      });
    }

    // F069: Hydrate unread summaries from read state store
    if (opts.readStateStore && messageStore && threads.length > 0) {
      const summaries = await opts.readStateStore.getUnreadSummaries(
        userId,
        threads.map((t) => t.id),
        messageStore,
      );
      const summaryMap = new Map(summaries.map((s) => [s.threadId, s]));
      return {
        threads: threads.map((t) => {
          const s = summaryMap.get(t.id);
          return { ...t, unreadCount: s?.unreadCount ?? 0, hasUserMention: s?.hasUserMention ?? false };
        }),
      };
    }

    return { threads };
  });

  // GET /api/threads/:id - 获取对话详情
  app.get('/api/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const thread = await threadStore.get(id);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    return thread;
  });

  // PATCH /api/threads/:id - 更新标题/置顶/收藏
  app.patch('/api/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = updateThreadSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const thread = await threadStore.get(id);
    if (!thread || thread.deletedAt) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    const { title, pinned, favorited, thinkingMode, preferredCats, routingPolicy, voiceMode, bootcampState } =
      parseResult.data;
    if (title !== undefined) await threadStore.updateTitle(id, title);
    if (pinned !== undefined) await threadStore.updatePin(id, pinned);
    if (favorited !== undefined) await threadStore.updateFavorite(id, favorited);
    if (thinkingMode !== undefined) await threadStore.updateThinkingMode(id, thinkingMode);
    if (preferredCats !== undefined) await threadStore.updatePreferredCats(id, preferredCats as CatId[]);
    if (routingPolicy !== undefined) {
      await threadStore.updateRoutingPolicy(id, routingPolicy as ThreadRoutingPolicyV1 | null);
    }
    if (voiceMode !== undefined) await threadStore.updateVoiceMode(id, voiceMode);
    if (bootcampState !== undefined) {
      await threadStore.updateBootcampState(id, bootcampState as BootcampStateV1 | null);
    }

    const updated = await threadStore.get(id);
    if (!updated) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    return updated;
  });

  // DELETE /api/threads/:id - 删除对话 (with cascade delete)
  app.delete('/api/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Protect active invocations from deletion (#35)
    // Atomic: guardDelete checks has() + marks "deleting" in one synchronous tick.
    // While guard is held, start() returns pre-aborted controller for this thread.
    const guard = opts.invocationTracker?.guardDelete(id);
    // Also check multi-mention dispatches (P1-2: they run outside InvocationTracker)
    const hasMMDispatches = getMultiMentionOrchestrator().hasActiveDispatches(id);
    if ((guard && !guard.acquired) || hasMMDispatches) {
      if (guard?.acquired) guard.release(); // Release tracker guard if we're blocking on MM
      reply.status(409);
      return {
        error: '猫猫正在工作中',
        detail: '请等待猫猫完成当前任务后再删除对话',
        code: 'ACTIVE_INVOCATION',
      };
    }

    try {
      const thread = await threadStore.get(id);

      // F095 Phase D: Soft-delete instead of hard delete — data preserved for trash bin
      const deleted = await threadStore.softDelete(id);
      if (!deleted) {
        reply.status(400);
        return { error: 'Cannot delete this thread' };
      }

      // I-2: Audit thread deletion for traceability (best-effort, don't block response)
      const userId = resolveUserId(request, {});
      void getEventAuditLog()
        .append({
          threadId: id,
          type: AuditEventTypes.THREAD_DELETED,
          data: {
            deletedBy: userId ?? 'unknown',
            threadTitle: thread?.title ?? null,
            projectPath: thread?.projectPath ?? null,
            softDelete: true,
          },
        })
        .catch((err) => {
          console.warn(`[threads] Audit log warning for ${id}:`, err);
        });

      reply.status(204);
      return;
    } finally {
      guard?.release();
    }
  });

  // F095 Phase D: POST /api/threads/:id/restore — restore a soft-deleted thread
  app.post<{ Params: { id: string } }>('/api/threads/:id/restore', async (request, reply) => {
    const { id } = request.params;
    const thread = await threadStore.get(id);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    const restored = await threadStore.restore(id);
    if (!restored) {
      reply.status(400);
      return { error: 'Thread is not deleted' };
    }

    const updated = await threadStore.get(id);
    return updated;
  });

  // F045: GET /api/threads/:threadId/task-progress — task progress snapshot for page refresh persistence
  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/task-progress', async (request, reply) => {
    const userId = resolveUserId(request, {});
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { threadId } = request.params;
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    if (thread.createdBy !== userId && thread.createdBy !== 'system') {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const snapshot = taskProgressStore ? await taskProgressStore.getThreadSnapshots(threadId) : {};
    return { threadId, taskProgress: snapshot };
  });

  // F35: PATCH /api/threads/:id/reveal — reveal all whispers in a thread
  app.patch<{ Params: { id: string } }>('/api/threads/:id/reveal', async (request, reply) => {
    const userId = resolveUserId(request, {});
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { id } = request.params;
    const thread = await threadStore.get(id);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    // Default thread is system-owned; allow any authenticated user to reveal.
    if (thread.createdBy !== userId && thread.createdBy !== 'system') {
      reply.status(403);
      return { error: 'Only the thread owner can reveal whispers' };
    }

    if (!messageStore) {
      reply.status(501);
      return { error: 'Message store not available' };
    }

    const revealed = await messageStore.revealWhispers(id, userId);
    return { revealed };
  });

  // F072: POST /api/threads/read/mark-all — mark all threads as read
  app.post('/api/threads/read/mark-all', async (request, reply) => {
    const userId = resolveUserId(request, {});
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    if (!opts.readStateStore || !messageStore) {
      reply.status(501);
      return { error: 'Read state store or message store not available' };
    }

    const threads = await threadStore.list(userId);
    let advancedCount = 0;

    for (const thread of threads) {
      const messages = await messageStore.getByThread(thread.id);
      if (messages.length === 0) continue;
      const latestId = messages[messages.length - 1]?.id;
      const advanced = await opts.readStateStore.ack(userId, thread.id, latestId);
      if (advanced) advancedCount++;
    }

    return { advancedCount, totalThreads: threads.length };
  });

  // F069: PATCH /api/threads/:id/read — mark thread as read up to messageId
  const readAckSchema = z.object({
    upToMessageId: z.string().min(1).max(100),
  });

  app.patch<{ Params: { id: string } }>('/api/threads/:id/read', async (request, reply) => {
    const userId = resolveUserId(request, {});
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    if (!opts.readStateStore) {
      reply.status(501);
      return { error: 'Read state store not available' };
    }

    const { id } = request.params;
    const thread = await threadStore.get(id);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    const parseResult = readAckSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    // P1-3: Validate upToMessageId belongs to this thread
    if (messageStore) {
      const msg = await messageStore.getById(parseResult.data.upToMessageId);
      if (!msg || msg.threadId !== id) {
        reply.status(400);
        return { error: 'upToMessageId does not belong to this thread' };
      }
    }

    const advanced = await opts.readStateStore.ack(userId, id, parseResult.data.upToMessageId);
    return { advanced };
  });

  // F069-R5: POST /api/threads/:id/read/latest — ack to latest real message server-side.
  // Eliminates frontend timing races: the server finds the latest message and acks it
  // in one atomic operation, so the client never needs to guess which ID to send.
  app.post<{ Params: { id: string } }>('/api/threads/:id/read/latest', async (request, reply) => {
    const userId = resolveUserId(request, {});
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    if (!opts.readStateStore) {
      reply.status(501);
      return { error: 'Read state store not available' };
    }

    if (!messageStore) {
      reply.status(501);
      return { error: 'Message store not available' };
    }

    const { id } = request.params;
    const thread = await threadStore.get(id);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    const messages = await messageStore.getByThread(id, 1);
    if (messages.length === 0) {
      return { advanced: false, reason: 'no messages' };
    }

    const latestId = messages[messages.length - 1]?.id;
    const advanced = await opts.readStateStore.ack(userId, id, latestId);
    return { advanced, messageId: latestId };
  });
};
