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
import type { IBallCustodyIngest } from '../domains/ball-custody/BallCustodyIngest.js';
import { buildHeldEvent } from '../domains/ball-custody/ball-custody-events.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { extractHoldBallClaims } from '../infrastructure/grounding/claim-extractors.js';
import { checkGrounding } from '../infrastructure/grounding/grounding-checker.js';
import { groundingSampleStore } from '../infrastructure/grounding/grounding-sample-singleton.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { TaskTemplate } from '../infrastructure/scheduler/templates/types.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { emitC1HoldCancellation } from './callback-hold-ball-c1-emit.js';
import { registerHoldBallCancelRoutes } from './callback-hold-ball-cancel-routes.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';
import { type CrossStoreTaskStore, detectEventCallback } from './gate-keeping-cross-store.js';
import { checkGateKeepingGuard } from './gate-keeping-guard.js';
import { HOLD_BALL_SOURCE } from './hold-ball-source.js';

const log = createModuleLogger('routes/callback-hold-ball');

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

/**
 * F167 Phase O PR-O2: WaitSourceRef schema for structured wait grounding.
 * Per R3.1 OQ-5: slaUntilMs is REQUIRED (no SLA = no hold).
 * 'reporter_handle' | 'pending_input' require anchorRef (narrative kinds too forgeable).
 */
const waitSourceRefSchema = z
  .object({
    kind: z.enum(['github_issue', 'github_comment', 'thread_message', 'task', 'reporter_handle', 'pending_input']),
    value: z.string().min(1),
    anchorRef: z.string().optional(),
    expectedSignal: z.string().min(1),
    slaUntilMs: z.number().int().positive(),
  })
  .refine(
    (data) => {
      // anchorRef REQUIRED for narrative kinds
      if ((data.kind === 'reporter_handle' || data.kind === 'pending_input') && !data.anchorRef) {
        return false;
      }
      return true;
    },
    { message: 'anchorRef is required for reporter_handle and pending_input kinds' },
  );

const holdBallSchema = z.object({
  reason: z.string().min(1).max(500),
  nextStep: z.string().min(1).max(500),
  wakeAfterMs: z.number().int().min(5_000).max(3_600_000),
  /** F167 Phase O: structured wait source for grounding telemetry (optional in PR-O2 shadow). */
  waitSourceRef: waitSourceRefSchema.optional(),
});

export interface HoldBallRouteDeps {
  registry: InvocationRegistry;
  taskRunner: TaskRunnerV2;
  templateRegistry: { get(id: string): TaskTemplate | undefined };
  dynamicTaskStore: DynamicTaskStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  threadStore: {
    get(threadId: string):
      | {
          createdBy: string;
          systemKind?: 'connector_hub' | 'eval_domain';
          /** F167: gate-keeping thread marker used by checkGateKeepingGuard. */
          threadKind?: 'concierge' | 'gate-keeping';
        }
      | null
      | Promise<{
          createdBy: string;
          systemKind?: 'connector_hub' | 'eval_domain';
          threadKind?: 'concierge' | 'gate-keeping';
        } | null>;
  };
  onHoldBallCancelFeedback?: (input: {
    taskId: string;
    threadId: string;
    userId: string;
    catId: string;
  }) => void | Promise<void>;
  ballCustody?: IBallCustodyIngest;
  /**
   * PR-O4: TaskStore for cross-store event callback detection.
   * When provided, hold_ball in gate-keeping threads checks whether
   * active PR/issue tracking exists → hasEventCallback policy context.
   */
  taskStore?: CrossStoreTaskStore;
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

    // F167 Phase O PR-O2b: shadow grounding telemetry with real claim extraction.
    // Fire-and-forget: don't await, don't let failures affect the hold_ball flow.
    void checkGrounding({
      invocationId: record.invocationId ?? 'unknown',
      catId: catIdStr,
      threadId,
      tool: 'hold_ball',
      actionFamily: 'wait',
      actionRisk: 'hold_ball',
      claims: extractHoldBallClaims({ reason, waitSourceRef: parsed.data.waitSourceRef }),
    })
      .then(async (result) => {
        for (const event of result.events) {
          await groundingSampleStore.record(event, result.wouldBlock);
        }
        log.debug(
          { threadId, catId: catIdStr, verdict: result.overallVerdict, wouldBlock: result.wouldBlock },
          'F167 Phase O: shadow grounding check completed (hold_ball)',
        );
      })
      .catch((err: unknown) => {
        log.warn({ err, threadId, catId: catIdStr }, 'F167 grounding shadow telemetry failed (non-blocking)');
      });

    // F167: gate-keeping thread guard (PR-O3 → PR-O4: cross-store callback detection)
    // PR-O4: detect event callback by querying TaskStore for active tracking
    // in the same thread. Pass waitSourceRef for subject-level matching:
    // only tracking tasks covering the SAME subject count as "event-backed."
    // Fail-open: if taskStore not injected or query fails,
    // hasEventCallback defaults to false (allows hold — conservative).
    const hasEventCallback = deps.taskStore
      ? await detectEventCallback(deps.taskStore, threadId, log, parsed.data.waitSourceRef)
      : false;
    const guardResult = await checkGateKeepingGuard({
      threadStore: deps.threadStore as Parameters<typeof checkGateKeepingGuard>[0]['threadStore'],
      threadId,
      tool: 'hold_ball',
      log,
      context: { catId: catIdStr, reason },
      policyContext: { wakeAfterMs, hasEventCallback, hasWaitSourceRef: !!parsed.data.waitSourceRef },
    });
    if (guardResult.outcome === 'blocked' && guardResult.blockedResponse) {
      reply.status(400);
      return guardResult.blockedResponse;
    }

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
    // F167 Phase M (M-2): de-frozen wake copy — guide re-evaluation instead of
    // commanding execution of a possibly-stale reason. The wake fires later (or after
    // defer), by which time the awaited condition may have changed; so prompt the cat
    // to re-judge rather than replay "球仍在你手上，现在执行".
    const wakeMessage =
      `持球唤醒：你之前因为「${reason}」持球。先重新评估当前是否还需要等——` +
      `若条件已满足，继续：${nextStep}；若仍未满足，可再持一次或升级（禁止无限持球）。`;

    const taskParams = {
      trigger: { type: 'once' as const, fireAt },
      params: {
        message: wakeMessage,
        targetCatId: catIdStr,
        triggerUserId: userId,
        // F167 Phase M (M-1 activation): pre-fire defer. If this cat's thread is busy
        // when the wake fires, the scheduler re-arms instead of delivering a stale wake.
        // Mechanism is scheduler-generic (firePolicy); hold_ball opts in here.
        deferWhileThreadBusy: true,
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

    deps.ballCustody
      ?.record(buildHeldEvent({ threadId, catId: catIdStr, fireAt, at: Date.now() }))
      .catch((err) => log.warn({ threadId, catId: catIdStr, taskId, err }, 'F233 PR3: failed to record ball.held'));

    // Cancel prior pending holds (best-effort — failure here leaves an extra
    // stale wake, not zero wakes, the milder failure mode). Telemetry: F192
    // verdict 2026-06-18 routes the cancellation by `bucketWakeDelay()` to
    // split zombie vs replacement metrics + span events (see
    // `callback-hold-ball-c1-emit.ts`). thread.system_kind derived from
    // threadStore (Phase D R1 P1-2 — hardcoded 'product' previously
    // misclassified eval-domain replacements).
    let threadSystemKind = 'product';
    if (pendingHolds.length > 0) {
      try {
        const thread = await deps.threadStore.get(threadId);
        if (thread?.systemKind) {
          threadSystemKind = thread.systemKind;
        }
      } catch {
        /* threadStore lookup failure → fall back to 'product' */
      }
    }
    const cancelNow = Date.now();
    for (const prior of pendingHolds) {
      const priorFireAt = (prior.trigger as { fireAt?: number }).fireAt ?? cancelNow;
      let wakeBucket: string | undefined;
      try {
        taskRunner.unregister(prior.id);
        dynamicTaskStore.remove(prior.id);
        const result = emitC1HoldCancellation({
          priorTaskId: prior.id,
          priorFireAtMs: priorFireAt,
          cancelNowMs: cancelNow,
          newTaskId: taskId,
          catId: catIdStr,
          threadId,
          threadSystemKind,
          invocationId: actor.invocationId,
        });
        wakeBucket = result.wakeBucket;
        log.info(
          { threadId, catId: catIdStr, priorTaskId: prior.id, newTaskId: taskId, wakeBucket, threadSystemKind },
          'F167 Phase G: cancelled prior pending hold wake (single-slot replace)',
        );
      } catch (err) {
        log.warn(
          { threadId, catId: catIdStr, priorTaskId: prior.id, err, wakeBucket, threadSystemKind },
          'F167 Phase G: failed to cancel prior hold — cat may see 2 wakes (prior + new)',
        );
      }
    }

    const newCount = incrementHoldCount(threadId, catIdStr);

    const wakeAtStr = new Date(fireAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const holdMessage = `🏓 ${catIdStr} 持球中 — ${reason}。预计 ${wakeAtStr} 唤醒，下一步：${nextStep}`;
    const holdSource = { ...HOLD_BALL_SOURCE, meta: { taskId, threadId, catId: catIdStr } };
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

  registerHoldBallCancelRoutes(app, deps);
}
