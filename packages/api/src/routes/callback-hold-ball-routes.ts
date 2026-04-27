/**
 * F167 Phase C1: Hold Ball Callback Routes
 * POST /api/callbacks/hold-ball — register ball hold + schedule wake-up via reminder template
 *
 * Semantic note (gpt52 review on PR #1289):
 * The hold counter is a ROLLING WINDOW counter, not a true "consecutive" counter.
 * A cat can hold up to MAX_HOLDS_PER_WINDOW times within HOLD_WINDOW_MS per
 * (threadId, catId); the window slides on each increment. State is process-local
 * (in-memory Map) — best-effort only. API restart or multi-instance deployments
 * will reset the counter. Durable enforcement would require sharing state with the
 * reminder scheduler; that is intentionally deferred.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { TaskTemplate } from '../infrastructure/scheduler/templates/types.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';
import { executeHoldCancel, findHoldBallTask } from './hold-ball-cancel.js';

const log = createModuleLogger('routes/callback-hold-ball');

const HOLD_BALL_SOURCE = {
  connector: 'hold-ball',
  label: '持球通知',
  icon: '🏓',
} as const;

/**
 * F167 Phase G P2 fix (cloud Codex round-2 + gpt52 local review):
 * pending-hold matching must rely on something NOT user-forgeable. Panel
 * callers of /api/schedule/tasks can set body.createdBy AND body.display.category,
 * but the taskId is always server-generated (`dyn-*` for panel, `hold-ball-*`
 * for this route). So we anchor on id prefix + templateId + createdBy +
 * deliveryThreadId — defense in depth with an unforgeable primary key.
 */
const HOLD_BALL_TASK_ID_PREFIX = 'hold-ball-';

export const MAX_HOLDS_PER_WINDOW = 3;
export const HOLD_WINDOW_MS = 3_600_000;

const holdCounts = new Map<string, { count: number; lastAt: number }>();

export function getHoldCount(threadId: string, catId: string, now: number = Date.now()): number {
  const key = `${threadId}:${catId}`;
  const entry = holdCounts.get(key);
  if (!entry) return 0;
  if (now - entry.lastAt > HOLD_WINDOW_MS) {
    holdCounts.delete(key);
    return 0;
  }
  return entry.count;
}

export function incrementHoldCount(threadId: string, catId: string, now: number = Date.now()): number {
  const key = `${threadId}:${catId}`;
  const entry = holdCounts.get(key);
  if (!entry || now - entry.lastAt > HOLD_WINDOW_MS) {
    holdCounts.set(key, { count: 1, lastAt: now });
    return 1;
  }
  entry.count++;
  entry.lastAt = now;
  return entry.count;
}

const holdBallSchema = z.object({
  reason: z.string().min(1).max(500),
  nextStep: z.string().min(1).max(500),
  wakeAfterMs: z.number().int().min(5_000).max(3_600_000),
});

export interface HoldBallRouteDeps {
  registry: InvocationRegistry;
  taskRunner: TaskRunnerV2;
  templateRegistry: { get(id: string): TaskTemplate | undefined };
  dynamicTaskStore: DynamicTaskStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  threadStore: { get(threadId: string): { createdBy: string } | null | Promise<{ createdBy: string } | null> };
}

export function registerCallbackHoldBallRoutes(app: FastifyInstance, deps: HoldBallRouteDeps): void {
  const { taskRunner, templateRegistry, dynamicTaskStore, messageStore, socketManager } = deps;

  app.post('/api/callbacks/hold-ball', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = holdBallSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { reason, nextStep, wakeAfterMs } = parsed.data;
    const { threadId, catId, userId } = actor;
    const catIdStr = catId as string;

    const currentCount = getHoldCount(threadId, catIdStr);
    if (currentCount >= MAX_HOLDS_PER_WINDOW) {
      log.warn(
        { threadId, catId: catIdStr, currentCount, windowMs: HOLD_WINDOW_MS },
        'F167 C1: hold_ball rejected — maxHoldsPerWindow reached',
      );
      reply.status(429);
      return {
        error:
          `maxHoldsPerWindow (${MAX_HOLDS_PER_WINDOW} per ~1h window) reached. ` +
          'You MUST pass the ball now: @ another cat or @co-creator.',
        holdsInWindow: currentCount,
        maxHoldsPerWindow: MAX_HOLDS_PER_WINDOW,
        windowMs: HOLD_WINDOW_MS,
      };
    }

    const template = templateRegistry.get('reminder');
    if (!template) {
      log.error('F167 C1: reminder template not found');
      reply.status(500);
      return { error: 'Internal error: reminder template not found' };
    }

    // F167 Phase G (KD-23): single-slot semantics. Before scheduling a new hold
    // wake, cancel + remove any pending hold task for the same (threadId, catId).
    // Keyed on `createdBy === 'hold-ball:{catId}'` + `deliveryThreadId === threadId`.
    // Per-cat rolling window counter is orthogonal (still enforced above).
    //
    // P1 fix (cloud Codex review on c04c5552a): the old sequence was
    // "cancel prior → insert new → register new", so if insert/register threw
    // partway we'd return 500 with NO scheduled wake (prior cancelled, new never
    // committed). Fix: insert + register the NEW task first; only on success
    // cancel prior. If any step throws, prior hold is retained untouched.
    // P2 fix (cloud Codex round-2 + gpt52 pushback): panel /api/schedule/tasks
    // lets users pass body.createdBy AND body.display.category, so both are
    // forgeable. Anchor on id prefix: `hold-ball-*` ids are only minted by this
    // route; `/api/schedule/tasks` mints `dyn-*`. Combine with templateId +
    // createdBy + deliveryThreadId for defense in depth.
    const pendingHoldCreatedBy = `hold-ball:${catIdStr}`;
    const pendingHolds = dynamicTaskStore
      .getAll()
      .filter(
        (t) =>
          t.id.startsWith(HOLD_BALL_TASK_ID_PREFIX) &&
          t.templateId === 'reminder' &&
          t.createdBy === pendingHoldCreatedBy &&
          t.deliveryThreadId === threadId,
      );

    const taskId = `hold-ball-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fireAt = Date.now() + wakeAfterMs;
    const wakeMessage =
      `持球唤醒：${reason}。球仍在你手上。现在执行：${nextStep}。` + '若条件仍未满足：再持一次或升级；禁止无限持球。';

    const taskParams = {
      trigger: { type: 'once' as const, fireAt },
      params: {
        message: wakeMessage,
        targetCatId: catIdStr,
        triggerUserId: userId,
      },
      deliveryThreadId: threadId as string | null,
    };

    const spec = template.createSpec(taskId, taskParams);

    dynamicTaskStore.insert({
      id: taskId,
      templateId: 'reminder',
      trigger: { type: 'once', fireAt },
      params: taskParams.params,
      display: {
        label: `持球唤醒 (${catIdStr})`,
        category: 'system',
        description: wakeMessage.slice(0, 100),
      },
      deliveryThreadId: threadId,
      enabled: true,
      createdBy: `hold-ball:${catIdStr}`,
      createdAt: new Date().toISOString(),
    });
    // Atomic swap: try register; on failure, remove the just-inserted row so
    // prior hold stays authoritative (caller gets 500; prior wake still fires).
    try {
      taskRunner.registerDynamic(spec, taskId);
    } catch (err) {
      dynamicTaskStore.remove(taskId);
      log.error(
        { threadId, catId: catIdStr, taskId, err },
        'F167 Phase G P1: taskRunner.registerDynamic failed — rolled back insert; prior hold (if any) retained',
      );
      reply.status(500);
      return { error: 'Failed to register hold wake with scheduler' };
    }

    // New hold fully committed. Cancel prior pending holds (best-effort — a
    // failure here leaves an extra stale wake, not zero wakes, which is the
    // milder of the two failure modes).
    for (const prior of pendingHolds) {
      try {
        taskRunner.unregister(prior.id);
        dynamicTaskStore.remove(prior.id);
        log.info(
          { threadId, catId: catIdStr, priorTaskId: prior.id, newTaskId: taskId },
          'F167 Phase G: cancelled prior pending hold wake (single-slot replace)',
        );
      } catch (err) {
        log.warn(
          { threadId, catId: catIdStr, priorTaskId: prior.id, err },
          'F167 Phase G: failed to cancel prior hold — cat may see 2 wakes (prior + new)',
        );
      }
    }

    const newCount = incrementHoldCount(threadId, catIdStr);

    const wakeAtStr = new Date(fireAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const holdMessage = `🏓 ${catIdStr} 持球中 — ${reason}。预计 ${wakeAtStr} 唤醒，下一步：${nextStep}`;
    const holdSource = { ...HOLD_BALL_SOURCE, meta: { taskId } };
    try {
      const stored = await messageStore.append({
        userId: 'system',
        catId: null,
        content: holdMessage,
        mentions: [],
        timestamp: Date.now(),
        threadId,
        source: holdSource,
      });
      socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
        threadId,
        message: {
          id: stored.id,
          type: 'connector',
          content: stored.content,
          source: holdSource,
          timestamp: stored.timestamp,
        },
      });
    } catch (err) {
      log.warn({ threadId, catId: catIdStr, err }, 'F167 C1: failed to post hold_ball visibility message');
    }

    log.info(
      {
        threadId,
        catId: catIdStr,
        reason,
        nextStep,
        wakeAfterMs,
        taskId,
        holdsInWindow: newCount,
        windowMs: HOLD_WINDOW_MS,
      },
      'F167 C1: hold_ball registered — wake-up scheduled',
    );

    return {
      status: 'ok',
      held: true,
      taskId,
      holdsInWindow: newCount,
      maxHoldsPerWindow: MAX_HOLDS_PER_WINDOW,
      windowMs: HOLD_WINDOW_MS,
      wakeAt: new Date(fireAt).toISOString(),
    };
  });

  app.delete<{ Params: { taskId: string } }>('/api/callbacks/hold-ball/:taskId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const { taskId } = request.params;
    const task = findHoldBallTask(taskId, dynamicTaskStore);
    if (!task) {
      reply.status(404);
      return { error: 'Hold task not found or not a hold-ball task' };
    }

    const threadId = task.deliveryThreadId;
    if (threadId) {
      const thread = await deps.threadStore.get(threadId);
      if (!thread || (thread.createdBy !== userId && thread.createdBy !== 'system')) {
        reply.status(403);
        return { error: 'Not authorized to cancel holds in this thread' };
      }
    }

    executeHoldCancel(task, { dynamicTaskStore, taskRunner });
    const catId = task.createdBy?.replace('hold-ball:', '') ?? 'unknown';
    log.info({ taskId, threadId, catId, userId }, 'F167 Phase J: hold_ball cancelled by user');

    if (threadId) {
      try {
        const cancelMessage = `🏓 ${catId} 持球已取消`;
        const stored = await messageStore.append({
          userId: 'system',
          catId: null,
          content: cancelMessage,
          mentions: [],
          timestamp: Date.now(),
          threadId,
          source: HOLD_BALL_SOURCE,
        });
        socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
          threadId,
          message: {
            id: stored.id,
            type: 'connector',
            content: stored.content,
            source: HOLD_BALL_SOURCE,
            timestamp: stored.timestamp,
          },
        });
      } catch (err) {
        log.warn({ taskId, threadId, err }, 'F167 Phase J: failed to post hold cancel visibility message');
      }
    }

    return { status: 'ok', cancelled: true, taskId };
  });
}
