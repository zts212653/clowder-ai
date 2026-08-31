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

import type { SchedulerAwaitStateV1, WaitOwnerFence } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  A2ADispatchDispositionError,
  type A2ADispatchDispositionService,
} from '../domains/ball-custody/A2ADispatchDispositionService.js';
import type { IBallCustodyIngest } from '../domains/ball-custody/BallCustodyIngest.js';
import { buildHeldEvent, buildWakeConditionMetEvent } from '../domains/ball-custody/ball-custody-events.js';
import {
  createInitialManagedCommandWakeProjection,
  ManagedCommandWakeRecoverySweep,
  type RecordManagedCommandCompletionInput,
} from '../domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import {
  ManagedHoldDispositionError,
  type ManagedHoldDispositionService,
} from '../domains/ball-custody/ManagedHoldDispositionService.js';
import type {
  InvocationRecord as CallbackInvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { extractHoldBallClaims } from '../infrastructure/grounding/claim-extractors.js';
import { checkGrounding } from '../infrastructure/grounding/grounding-checker.js';
import { groundingSampleStore } from '../infrastructure/grounding/grounding-sample-singleton.js';
import { ledgerIdForGuard } from '../infrastructure/harness-eval/guard-ledger-registry.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import { KILL_GRACE_MS, ManagedRunner, type WakeWhenResult } from '../infrastructure/managed-runner.js';
import type { DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { TaskTemplate } from '../infrastructure/scheduler/templates/types.js';
import { holdBallPendingInputReject, holdBallUngroundedTimerReject } from '../infrastructure/telemetry/instruments.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { emitC1HoldCancellation } from './callback-hold-ball-c1-emit.js';
import { registerHoldBallCancelRoutes } from './callback-hold-ball-cancel-routes.js';
import { deriveCallbackActor, getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';
import type { CrossStoreTaskStore } from './gate-keeping-cross-store.js';
import { checkGateKeepingGuard } from './gate-keeping-guard.js';
import {
  deriveHoldSubjectKeyFromWaitSourceRef,
  isPendingHoldBallTask,
  normalizeHoldExpectedSignalKey,
  readHoldLifecycle,
} from './hold-ball-cancel.js';
import {
  HOLD_WINDOW_MS as COUNTER_WINDOW_MS,
  HOLD_MODE_COMMAND,
  HOLD_MODE_TIMER,
  releaseHoldReservation,
  tryReserveHold,
} from './hold-ball-counter.js';
import { HOLD_BALL_SOURCE } from './hold-ball-source.js';
import { resolveManagedHoldTriggerUserId } from './managed-hold-trigger-user.js';

const log = createModuleLogger('routes/callback-hold-ball');

export type { HoldMode, ReservationResult } from './hold-ball-counter.js';
export {
  getCommandHoldCount,
  getHoldCount,
  getTimerHoldCount,
  HOLD_MODE_COMMAND,
  HOLD_MODE_TIMER,
  HOLD_WINDOW_MS,
  incrementCommandHoldCount,
  incrementHoldCount,
  incrementTimerHoldCount,
  MAX_COMMAND_HOLDS_PER_WINDOW,
  MAX_HOLDS_PER_WINDOW,
  MAX_TIMER_HOLDS_PER_WINDOW,
  releaseHoldReservation,
  tryReserveHold,
} from './hold-ball-counter.js';

/**
 * F167 Phase P review P1-1 fix: active wakeWhen runner registry.
 * Keyed by `${threadId}:${catId}` — single-slot semantics means at most one
 * active runner per (thread, cat). Cancel/replace paths call cancelWakeWhenRunner()
 * so the old process is killed and its completion callback knows to bail out.
 */
type ManagedWakeCancellationDecision = 'cancel' | 'resume';

interface ActiveManagedRunner {
  taskId: string;
  runner: ManagedRunner;
  phase: 'pending_launch' | 'running' | 'cancellation_reserved' | 'delivering';
  reservationResumePhase?: 'pending_launch' | 'running';
  reservationToken?: number;
  reservationDecision?: {
    promise: Promise<ManagedWakeCancellationDecision>;
    resolve: (decision: ManagedWakeCancellationDecision) => void;
  };
}

export type ManagedWakeCancellationReservationResult =
  | { outcome: 'reserved'; token: number }
  | { outcome: 'execution_started' | 'cancellation_pending' | 'not_found' };

const activeRunners = new Map<string, ActiveManagedRunner>();
let nextManagedWakeCancellationToken = 1;

function cancelManagedRunner(key: string, entry: ActiveManagedRunner): void {
  entry.reservationDecision?.resolve('cancel');
  entry.runner.cancel();
  if (activeRunners.get(key) === entry) activeRunners.delete(key);
}

/**
 * Cancel a running wakeWhen command for a (threadId, catId) pair.
 * Exported so cancel routes can call it alongside executeHoldCancel.
 * No-op if no runner is active for the given key.
 */
export function cancelWakeWhenRunner(threadId: string, catId: string): void {
  const key = `${threadId}:${catId}`;
  const entry = activeRunners.get(key);
  if (entry) {
    cancelManagedRunner(key, entry);
    log.info({ threadId, catId }, 'F167 Phase P: cancelled wakeWhen runner (cancel/replace)');
  }
}

export function reserveManagedWakeCancellation(
  taskId: string,
  threadId: string,
  catId: string,
): ManagedWakeCancellationReservationResult {
  const entry = activeRunners.get(`${threadId}:${catId}`);
  if (!entry || entry.taskId !== taskId) return { outcome: 'not_found' };
  if (entry.phase === 'delivering') return { outcome: 'execution_started' };
  if (entry.phase === 'cancellation_reserved') return { outcome: 'cancellation_pending' };
  let resolveDecision: (decision: ManagedWakeCancellationDecision) => void = () => {};
  const promise = new Promise<ManagedWakeCancellationDecision>((resolve) => {
    resolveDecision = resolve;
  });
  const token = nextManagedWakeCancellationToken++;
  entry.reservationResumePhase = entry.phase;
  entry.phase = 'cancellation_reserved';
  entry.reservationToken = token;
  entry.reservationDecision = { promise, resolve: resolveDecision };
  return { outcome: 'reserved', token };
}

export function commitManagedWakeCancellation(taskId: string, threadId: string, catId: string, token: number): boolean {
  const key = `${threadId}:${catId}`;
  const entry = activeRunners.get(key);
  if (entry?.taskId !== taskId || entry.reservationToken !== token) return false;
  cancelManagedRunner(key, entry);
  return true;
}

export function releaseManagedWakeCancellation(
  taskId: string,
  threadId: string,
  catId: string,
  token: number,
): boolean {
  const entry = activeRunners.get(`${threadId}:${catId}`);
  if (entry?.taskId !== taskId || entry.reservationToken !== token) return false;
  const decision = entry.reservationDecision;
  entry.phase = entry.reservationResumePhase ?? 'running';
  delete entry.reservationResumePhase;
  delete entry.reservationToken;
  delete entry.reservationDecision;
  decision?.resolve('resume');
  return true;
}

export function cancelManagedWakeIfTaskMatches(taskId: string, threadId: string, catId: string): boolean {
  const key = `${threadId}:${catId}`;
  const entry = activeRunners.get(key);
  if (entry?.taskId !== taskId) return false;
  cancelManagedRunner(key, entry);
  return true;
}

async function enterManagedWakeDelivery(
  registryKey: string,
  runner: ManagedRunner,
  taskId: string,
): Promise<ActiveManagedRunner | null> {
  const current = activeRunners.get(registryKey);
  if (!current || current.runner !== runner || current.taskId !== taskId) return null;
  if (current.phase === 'cancellation_reserved') {
    const decision = await current.reservationDecision?.promise;
    if (decision !== 'resume') return null;
  }
  const ready = activeRunners.get(registryKey);
  if (!ready || ready.runner !== runner || ready.taskId !== taskId || ready.phase !== 'running') return null;
  ready.phase = 'delivering';
  return ready;
}

/** Test-only: get the active runners map size for assertions. */
export function getActiveRunnerCount(): number {
  return activeRunners.size;
}

interface PreparedManagedWakeRunner {
  registryKey: string;
  entry: ActiveManagedRunner;
}

function prepareWakeWhenRunner(threadId: string, catId: string, taskId: string): PreparedManagedWakeRunner {
  const registryKey = `${threadId}:${catId}`;
  cancelWakeWhenRunner(threadId, catId);
  const entry: ActiveManagedRunner = {
    taskId,
    runner: new ManagedRunner(),
    phase: 'pending_launch',
  };
  activeRunners.set(registryKey, entry);
  return { registryKey, entry };
}

/**
 * F167 Phase O PR-O2 → PR-O3: WaitSourceRef schema for structured wait grounding.
 * Per R3.1 OQ-5: slaUntilMs is REQUIRED (no SLA = no hold).
 * 'reporter_handle' requires anchorRef (narrative kind, too forgeable without anchor).
 *
 * PR-O3: 'pending_input' REMOVED — it semantically meant "wait for human/cat to type
 * in the Hub", which should be @co-creator (传球选项3) not hold_ball. This was the primary
 * backdoor enabling the "hold_ball instead of @co-creator" misuse pattern.
 */
const waitSourceRefSchema = z
  .object({
    kind: z.enum(['github_issue', 'github_comment', 'thread_message', 'task', 'reporter_handle', 'managed_command']),
    value: z.string().min(1),
    anchorRef: z.string().optional(),
    expectedSignal: z.string().min(1),
    slaUntilMs: z.number().int().positive(),
  })
  .refine(
    (data) => {
      // anchorRef REQUIRED for narrative kinds (reporter_handle only after pending_input removal)
      if (data.kind === 'reporter_handle' && !data.anchorRef) {
        return false;
      }
      return true;
    },
    { message: 'anchorRef is required for reporter_handle kind' },
  );

const wakeWhenSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
});

const holdBallSchema = z
  .object({
    reason: z.string().min(1).max(500),
    nextStep: z.string().min(1).max(500),
    wakeAfterMs: z.number().int().min(5_000).max(3_600_000).optional(),
    /** F167 Phase P: run a command and wake when it completes (mutually exclusive with wakeAfterMs). */
    wakeWhen: wakeWhenSchema.optional(),
    /**
     * F167 Phase O → PR-O3: structured wait source for grounding telemetry.
     * REQUIRED for wakeAfterMs mode — you must declare what external condition
     * justifies the timer. wakeWhen mode is self-grounded (the command IS the source).
     *
     * If you are waiting for a human (co-creator / another cat) to reply in the Hub,
     * do NOT hold_ball — use @co-creator or @句柄 instead (传球选项 1 or 3).
     */
    waitSourceRef: waitSourceRefSchema.optional(),
  })
  .refine(
    (data) => {
      const hasWakeAfter = data.wakeAfterMs != null;
      const hasWakeWhen = data.wakeWhen != null;
      return (hasWakeAfter || hasWakeWhen) && !(hasWakeAfter && hasWakeWhen);
    },
    { message: 'Exactly one of wakeAfterMs or wakeWhen must be provided' },
  )
  .refine(
    (data) => {
      // PR-O3: wakeAfterMs mode REQUIRES waitSourceRef — must declare what you're waiting for.
      // wakeWhen mode is self-grounded (the command is the external condition).
      if (data.wakeAfterMs != null && data.waitSourceRef == null) {
        return false;
      }
      return true;
    },
    {
      message:
        'waitSourceRef is required when using wakeAfterMs — declare what external condition ' +
        'you are polling. If waiting for a human reply, use @co-creator instead of hold_ball.',
    },
  );

export interface HoldBallRouteDeps {
  registry: InvocationRegistry;
  taskRunner: TaskRunnerV2;
  templateRegistry: { get(id: string): TaskTemplate | undefined };
  dynamicTaskStore: DynamicTaskStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  ownerUserId: string;
  scheduleMutationAuditStore: {
    deleteTaskWithAudit(taskId: string, audit: import('@cat-cafe/shared').ScheduleMutationAuditEntry): boolean;
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
  invocationRecordStore: IInvocationRecordStore;
  managedCommandWakeRecovery?: Pick<ManagedCommandWakeRecoverySweep, 'recordCompletion'> &
    Partial<Pick<ManagedCommandWakeRecoverySweep, 'recordCancelledCompletion' | 'recordRetiredCompletion'>>;
  /**
   * F167 Phase P: invocation trigger for wakeWhen command completion.
   * When provided, wakeWhen command results are delivered via invokeTrigger.
   * When absent, wakeWhen falls back to message-only delivery (no cat auto-invocation).
   */
  invokeTrigger?: {
    trigger(
      threadId: string,
      catId: string,
      userId: string,
      message: string,
      messageId: string,
      contentBlocks?: undefined,
      policy?: { sourceCategory?: string },
    ): Promise<'enqueued' | 'full'>;
  };
  /** F167×F254: exact current-wake terminal producer. */
  managedHoldDispositionService?: Pick<ManagedHoldDispositionService, 'complete'>;
  /** F167: exact ordinary A2A dispatch terminal producer. */
  a2aDispatchDispositionService?: Pick<A2ADispatchDispositionService, 'complete'>;
  /** F257: fail-open observation ledger for callback guard rejections. */
  guardRejectionLog?: import('../infrastructure/harness-eval/GuardRejectionEventLog.js').GuardRejectionEventLog;
}

export async function resolveHoldWaitOwnerFence(
  record: Pick<CallbackInvocationRecord, 'invocationId' | 'parentInvocationId' | 'threadId' | 'userId' | 'catId'>,
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>,
): Promise<WaitOwnerFence> {
  const containingTaskFence = Object.freeze({ kind: 'containing_task' as const, generation: 1 });
  if (!record.parentInvocationId) return containingTaskFence;

  const stored = await invocationRecordStore.get(record.parentInvocationId);
  if (
    !stored ||
    stored.threadId !== record.threadId ||
    stored.userId !== record.userId ||
    !stored.targetCats.includes(record.catId)
  ) {
    throw new Error('callback parent invocation is outside the authenticated hold owner scope');
  }
  if (stored.actionLeaseCarrier.kind === 'none') return containingTaskFence;
  return Object.freeze({
    kind: 'action_successor',
    leaseId: stored.actionLeaseCarrier.leaseId,
    generation: stored.actionLeaseCarrier.generation,
  });
}

/**
 * F167 Phase P: fire-and-forget managed command runner.
 * Extracted from route handler to reduce cognitive complexity.
 *
 * P1-1 fix: runner stored in activeRunners registry, cancel/replace-aware.
 * S.1-c: terminal result enters the durable hold lifecycle before visibility
 * and execution-plane dispatch are attempted.
 */
function launchWakeWhenRunner(opts: {
  wakeWhen: { command: string; cwd?: string; timeoutMs?: number };
  reason: string;
  nextStep: string;
  threadId: string;
  catId: string;
  taskId: string;
  deps: HoldBallRouteDeps;
  prepared: PreparedManagedWakeRunner;
}): void {
  const { wakeWhen, reason, nextStep, threadId, catId, taskId, deps, prepared } = opts;
  const { registryKey, entry: activeEntry } = prepared;
  const { runner } = activeEntry;

  void (async () => {
    try {
      const pending = activeRunners.get(registryKey);
      if (pending !== activeEntry || pending.taskId !== taskId) return;
      if (pending.phase === 'cancellation_reserved') {
        const decision = await pending.reservationDecision?.promise;
        if (decision !== 'resume') return;
      }
      const admitted = activeRunners.get(registryKey);
      if (admitted !== activeEntry || admitted.taskId !== taskId || admitted.phase !== 'pending_launch') return;
      admitted.phase = 'running';

      const result = await runner.launch(wakeWhen.command, {
        cwd: wakeWhen.cwd,
        timeoutMs: wakeWhen.timeoutMs,
      });

      const wakeContent = buildManagedCommandWakeContent(result, reason, wakeWhen.command, nextStep);
      const completion: RecordManagedCommandCompletionInput = {
        taskId,
        wakeContent,
        result: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          cancelled: runner.state === 'cancelled',
          durationMs: result.durationMs,
          ...(result.tailOutput ? { tailOutput: result.tailOutput } : {}),
        },
      };
      const recovery =
        deps.managedCommandWakeRecovery ??
        new ManagedCommandWakeRecoverySweep({
          dynamicTaskStore: deps.dynamicTaskStore,
          messageStore: deps.messageStore,
          socketManager: deps.socketManager,
          taskRunner: deps.taskRunner,
          invocationRecordStore: deps.invocationRecordStore,
          getInvokeTrigger: () => deps.invokeTrigger,
        });

      // F295: an ordinary user message can retire the wake carrier, but it is
      // not an execution-scoped cancellation request. Let the independent
      // command finish, retain its exact terminal evidence, and suppress the
      // now-obsolete wake delivery.
      const retiredTask = deps.dynamicTaskStore.getById(taskId);
      const lifecycle = retiredTask ? readHoldLifecycle(retiredTask) : null;
      if (lifecycle?.status === 'cancelled_by_user') {
        const recoveryResult = recovery.recordRetiredCompletion
          ? await recovery.recordRetiredCompletion(completion)
          : recovery.recordCancelledCompletion
            ? await recovery.recordCancelledCompletion(completion)
            : 'missing';
        if (activeRunners.get(registryKey) === activeEntry) activeRunners.delete(registryKey);
        log.info(
          { threadId, catId, command: wakeWhen.command, taskId, recoveryResult },
          'F295: retired wakeWhen carrier retained terminal evidence without duplicate invocation dispatch',
        );
        return;
      }

      // P1-1 staleness check: if this runner was replaced or cancelled while running,
      // the registry will have a different runner (or none). Don't deliver stale wake,
      // but retain the terminal result when a user message preserved a cancellation tombstone.
      const current = activeRunners.get(registryKey);
      if (!current || current.runner !== runner || current.taskId !== taskId) {
        const recoveryResult = recovery.recordCancelledCompletion
          ? await recovery.recordCancelledCompletion(completion)
          : 'missing';
        log.info(
          { threadId, catId, command: wakeWhen.command, taskId, recoveryResult },
          'F167 Phase P: wakeWhen runner completed after replacement/cancellation — terminal evidence retained when eligible',
        );
        return;
      }
      const ready = await enterManagedWakeDelivery(registryKey, runner, taskId);
      if (!ready) return;

      deps.ballCustody
        ?.record(
          buildWakeConditionMetEvent({
            threadId,
            catId,
            taskId,
            command: wakeWhen.command,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            at: Date.now(),
          }),
        )
        .catch((err) => log.warn({ threadId, catId, err }, 'F167 Phase P: failed to record ball.wake_condition_met'));

      const recoveryResult = await recovery.recordCompletion(completion);

      log.info(
        {
          threadId,
          catId,
          command: wakeWhen.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          taskId,
          recoveryResult,
        },
        'F167 S.1-c: wakeWhen command completed and entered durable recovery',
      );
      if (activeRunners.get(registryKey) === ready) activeRunners.delete(registryKey);
    } catch (err) {
      // Clean up registry on unexpected failure too
      if (activeRunners.get(registryKey)?.runner === runner) {
        activeRunners.delete(registryKey);
      }
      log.error(
        { threadId, catId, command: wakeWhen.command, err },
        'F167 Phase P: wakeWhen runner failed — fallback reminder will still fire',
      );
    }
  })();
}

function buildManagedCommandWakeContent(
  result: WakeWhenResult,
  reason: string,
  command: string,
  nextStep: string,
): string {
  const statusLabel = result.timedOut ? '⏰ 超时' : result.exitCode === 0 ? '✅ 成功' : `❌ 退出码 ${result.exitCode}`;
  const tail = result.tailOutput ? `输出尾部：\n\`\`\`\n${result.tailOutput}\n\`\`\`\n` : '';
  return (
    `持球唤醒（命令完成）：你之前因为「${reason}」持球，运行了「${command}」。\n` +
    `结果：${statusLabel}（耗时 ${Math.round(result.durationMs / 1000)}s）\n` +
    tail +
    `下一步：${nextStep}`
  );
}

export function registerCallbackHoldBallRoutes(app: FastifyInstance, deps: HoldBallRouteDeps): void {
  const { taskRunner, templateRegistry, dynamicTaskStore, messageStore, socketManager } = deps;

  app.post('/api/callbacks/hold-ball', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const deletedThreadGuard = await getDeletedCallbackThreadGuard(deps.threadStore, actor.threadId);
    if (deletedThreadGuard) {
      reply.status(deletedThreadGuard.statusCode);
      return deletedThreadGuard.body;
    }

    // PR-O3 eval counters: detect misuse attempts BEFORE schema parse.
    // These fire on every attempt regardless of other validation failures,
    // tracking how often cats still TRY the patterns we're blocking.
    const rawBody = request.body as Record<string, unknown> | null;
    if (rawBody?.wakeAfterMs != null && rawBody?.waitSourceRef == null) {
      holdBallUngroundedTimerReject.add(1);
    }
    if ((rawBody?.waitSourceRef as Record<string, unknown> | null)?.kind === 'pending_input') {
      holdBallPendingInputReject.add(1);
    }

    const parsed = holdBallSchema.safeParse(request.body);
    if (!parsed.success) {
      const ungroundedTimer = rawBody?.wakeAfterMs != null && rawBody?.waitSourceRef == null;
      if (ungroundedTimer && deps.guardRejectionLog) {
        const { randomUUID } = await import('node:crypto');
        deps.guardRejectionLog
          .append({
            eventId: randomUUID(),
            ledgerId: ledgerIdForGuard('hold_ball_wait_source_ref'),
            kind: 'http_schema_reject',
            threadId: actor.threadId,
            catId: actor.catId as string,
            guardId: 'hold_ball_wait_source_ref',
            ownerUserId: actor.userId,
            invocationId: record.invocationId ?? 'unknown',
            sourceTool: 'hold_ball',
            normalizedReason: 'missing_wait_source_ref',
            layer: 'api-route',
            timestamp: Date.now(),
            correlationConfidence: record.invocationId ? 'exact' : 'window',
          })
          .catch(() => {});
      }
      reply.status(400);
      return {
        error: 'Invalid request body',
        details: parsed.error.issues,
        ...(ungroundedTimer ? { ledgerId: ledgerIdForGuard('hold_ball_wait_source_ref') } : {}),
      };
    }

    const { reason, nextStep, wakeWhen } = parsed.data;
    // wakeAfterMs: explicit timed wake, OR derived from wakeWhen timeout (for single-slot/visibility)
    const wakeAfterMs = parsed.data.wakeAfterMs ?? wakeWhen?.timeoutMs ?? 600_000;
    const { threadId, catId, userId } = actor;
    const catIdStr = catId as string;
    const triggerUserId = await resolveManagedHoldTriggerUserId({
      actorUserId: userId,
      threadId,
      threadStore: deps.threadStore,
    });

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

    const guardResult = await checkGateKeepingGuard({
      threadStore: deps.threadStore as Parameters<typeof checkGateKeepingGuard>[0]['threadStore'],
      threadId,
      tool: 'hold_ball',
      log,
      context: { catId: catIdStr, reason },
      policyContext: { wakeAfterMs, hasEventCallback: false, hasWaitSourceRef: !!parsed.data.waitSourceRef },
    });
    if (guardResult.outcome === 'blocked' && guardResult.blockedResponse) {
      if (deps.guardRejectionLog) {
        const { randomUUID } = await import('node:crypto');
        deps.guardRejectionLog
          .append({
            eventId: randomUUID(),
            ledgerId: ledgerIdForGuard('gate_keeping_thread_default'),
            kind: 'http_policy_reject',
            threadId: actor.threadId,
            catId: catIdStr,
            guardId: 'gate_keeping_thread_default',
            ownerUserId: userId,
            invocationId: record.invocationId ?? 'unknown',
            sourceTool: 'hold_ball',
            normalizedReason: 'gate_keeping_thread_default_blocked',
            layer: 'api-route',
            timestamp: Date.now(),
            correlationConfidence: record.invocationId ? 'exact' : 'window',
          })
          .catch(() => {});
      }
      reply.status(400);
      return { ...guardResult.blockedResponse, ledgerId: ledgerIdForGuard('gate_keeping_thread_default') };
    }

    // Read pending holds before reserving quota: a storage read failure must
    // not consume a slot for a request that never reaches scheduling.
    const pendingHoldCreatedBy = `hold-ball:${catIdStr}`;
    const pendingHolds = dynamicTaskStore
      .getAll()
      .filter(
        (task) =>
          isPendingHoldBallTask(task) && task.createdBy === pendingHoldCreatedBy && task.deliveryThreadId === threadId,
      );

    const holdMode = wakeWhen ? HOLD_MODE_COMMAND : HOLD_MODE_TIMER;
    const reservation = tryReserveHold(holdMode, threadId, catIdStr);
    if (!reservation.admitted) {
      log.warn(
        {
          threadId,
          catId: catIdStr,
          currentCount: reservation.count,
          holdMode,
          maxForMode: reservation.max,
          windowMs: COUNTER_WINDOW_MS,
        },
        'F167 C1: hold_ball rejected — maxHoldsPerWindow reached',
      );
      reply.status(429);
      const rateLimitLedgerId = ledgerIdForGuard('hold_ball_rate_limit');
      if (deps.guardRejectionLog) {
        const { randomUUID } = await import('node:crypto');
        deps.guardRejectionLog
          .append({
            eventId: randomUUID(),
            ledgerId: rateLimitLedgerId,
            kind: 'http_rate_limit',
            threadId,
            catId: catIdStr,
            guardId: 'hold_ball_rate_limit',
            ownerUserId: userId,
            invocationId: record.invocationId ?? 'unknown',
            sourceTool: 'hold_ball',
            normalizedReason: 'rate_limited',
            layer: 'api-route',
            timestamp: Date.now(),
            correlationConfidence: record.invocationId ? 'exact' : 'window',
            holdMode,
            currentCount: reservation.count,
            maxAllowed: reservation.max,
            windowMs: COUNTER_WINDOW_MS,
          })
          .catch(() => {});
      }
      return {
        error:
          `maxHoldsPerWindow (${reservation.max} per ~1h window, mode=${holdMode}) reached. ` +
          'You MUST pass the ball now: @ another cat or @co-creator.',
        ledgerId: rateLimitLedgerId,
        holdMode,
        holdsInWindow: reservation.count,
        maxHoldsPerWindow: reservation.max,
        windowMs: COUNTER_WINDOW_MS,
      };
    }

    const template = templateRegistry.get('reminder');
    if (!template) {
      releaseHoldReservation(holdMode, threadId, catIdStr, reservation._prior);
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
    const createdAt = Date.now();
    const taskId = `hold-ball-${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
    // P2-2 cloud review fix: for wakeWhen, the fallback reminder must fire AFTER the
    // runner's timeout + grace period, not at the same time. Otherwise both the runner
    // timeout wake and the fallback reminder can fire simultaneously (race → double wake).
    const fallbackBuffer = wakeWhen ? KILL_GRACE_MS + 10_000 : 0;
    const fireAt = createdAt + wakeAfterMs + fallbackBuffer;
    // F167 Phase M (M-2): de-frozen wake copy — guide re-evaluation instead of
    // commanding execution of a possibly-stale reason. The wake fires later (or after
    // defer), by which time the awaited condition may have changed; so prompt the cat
    // to re-judge rather than replay "球仍在你手上，现在执行".
    const wakeMessage =
      `持球唤醒：你之前因为「${reason}」持球。先重新评估当前是否还需要等——` +
      `若条件已满足，继续：${nextStep}；若仍未满足，可再持一次或升级（禁止无限持球）。`;
    const holdSubjectKey = deriveHoldSubjectKeyFromWaitSourceRef(parsed.data.waitSourceRef);
    const holdExpectedSignalKey = normalizeHoldExpectedSignalKey(parsed.data.waitSourceRef?.expectedSignal);
    let ownerFence: WaitOwnerFence;
    try {
      ownerFence = await resolveHoldWaitOwnerFence(record, deps.invocationRecordStore);
    } catch (err) {
      releaseHoldReservation(holdMode, threadId, catIdStr, reservation._prior);
      log.error(
        { err, invocationId: record.invocationId, parentInvocationId: record.parentInvocationId },
        'F280 Phase D: canonical hold owner fence is unavailable',
      );
      reply.status(503);
      return { error: 'Canonical hold owner fence is unavailable', code: 'HOLD_OWNER_FENCE_UNAVAILABLE' };
    }
    const schedulerAwait: SchedulerAwaitStateV1 = wakeWhen
      ? {
          v: 1,
          generation: 1,
          subjectRef: `command:${taskId}`,
          ownerFence,
          baseline: {
            kind: 'managed_command',
            capturedAt: createdAt,
            deadlineAt: createdAt + wakeAfterMs,
          },
          continuation: {
            when: [{ kind: 'managed_command_completed' }],
            // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
            then: nextStep,
          },
          expiresAt: fireAt,
          createdAt,
          provenance: 'explicit_registration',
        }
      : {
          v: 1,
          generation: 1,
          subjectRef: `timer:${taskId}`,
          ownerFence,
          baseline: { kind: 'timer', capturedAt: createdAt, fireAt },
          continuation: {
            when: [{ kind: 'timer_elapsed' }],
            // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
            then: nextStep,
          },
          expiresAt: fireAt,
          createdAt,
          provenance: 'explicit_registration',
        };
    const holdLifecycle =
      parsed.data.waitSourceRef || wakeWhen
        ? {
            mode: wakeWhen ? ('wake_when' as const) : ('timer' as const),
            status: 'active' as const,
            await: schedulerAwait,
            waitSourceRef: parsed.data.waitSourceRef,
            ...(holdSubjectKey ? { subjectKey: holdSubjectKey } : {}),
            ...(holdExpectedSignalKey ? { expectedSignalKey: holdExpectedSignalKey } : {}),
            wakeAt: fireAt,
            createdBy: `hold-ball:${catIdStr}`,
            ...(wakeWhen
              ? { managedCommand: createInitialManagedCommandWakeProjection(wakeWhen.command, createdAt) }
              : {}),
          }
        : undefined;

    const taskParams = {
      trigger: { type: 'once' as const, fireAt },
      params: {
        message: wakeMessage,
        targetCatId: catIdStr,
        triggerUserId,
        // F167 Phase M (M-1 activation): pre-fire defer. If this cat's thread is busy
        // when the wake fires, the scheduler re-arms instead of delivering a stale wake.
        // Mechanism is scheduler-generic (firePolicy); hold_ball opts in here.
        deferWhileThreadBusy: true,
        ...(holdLifecycle ? { holdLifecycle } : {}),
      },
      deliveryThreadId: threadId as string | null,
    };

    // Keep every fallible scheduling step inside one rollback boundary so a
    // failed request cannot consume quota without producing a wake.
    try {
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
      taskRunner.registerDynamic(spec, taskId);
    } catch (err) {
      try {
        dynamicTaskStore.remove(taskId);
      } catch {
        /* best effort: insert may not have run, or the store may be unavailable */
      }
      releaseHoldReservation(holdMode, threadId, catIdStr, reservation._prior);
      log.error(
        { threadId, catId: catIdStr, taskId, err },
        'F167 Phase G P1: createSpec/insert/registerDynamic failed — rolled back insert + counter; prior hold retained',
      );
      reply.status(500);
      return { error: 'Failed to register hold wake with scheduler' };
    }

    // F280: establish managed-command cancellation admission in the same
    // synchronous turn as scheduler registration. Any later await (including
    // visibility persistence) can now race only through this canonical slot.
    const preparedWakeRunner = wakeWhen ? prepareWakeWhenRunner(threadId, catIdStr, taskId) : undefined;

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
    // prepareWakeWhenRunner already replaces an active command synchronously;
    // timer-only replacements still need to cancel the prior managed command here.
    if (pendingHolds.length > 0 && !preparedWakeRunner) {
      cancelWakeWhenRunner(threadId, catIdStr);
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

    const newCount = reservation.count;

    const wakeAtStr = new Date(fireAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const holdMessage = wakeWhen
      ? `🏓 ${catIdStr} 持球中 — ${reason}。命令「${wakeWhen.command}」已启动，完成后自动唤醒。下一步：${nextStep}`
      : `🏓 ${catIdStr} 持球中 — ${reason}。预计 ${wakeAtStr} 唤醒，下一步：${nextStep}`;
    const holdSource = { ...HOLD_BALL_SOURCE, meta: { taskId, threadId, catId: catIdStr } };
    try {
      const stored = await messageStore.append({
        from: { kind: 'system', service: 'hold-ball' },
        userId: 'system',
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

    // ── F167 Phase P: wakeWhen — launch managed command, wake cat on completion ──
    if (wakeWhen && preparedWakeRunner) {
      launchWakeWhenRunner({
        wakeWhen,
        reason,
        nextStep,
        threadId,
        catId: catIdStr,
        taskId,
        deps,
        prepared: preparedWakeRunner,
      });
    }

    log.info(
      {
        threadId,
        catId: catIdStr,
        reason,
        nextStep,
        wakeAfterMs,
        wakeWhen: wakeWhen ? { command: wakeWhen.command, timeoutMs: wakeWhen.timeoutMs } : undefined,
        taskId,
        holdMode,
        holdsInWindow: newCount,
        windowMs: COUNTER_WINDOW_MS,
      },
      'F167 C1: hold_ball registered — wake-up scheduled',
    );

    return {
      status: 'ok',
      held: true,
      taskId,
      holdMode,
      holdsInWindow: newCount,
      maxHoldsPerWindow: reservation.max,
      windowMs: COUNTER_WINDOW_MS,
      wakeAt: new Date(fireAt).toISOString(),
      ...(wakeWhen ? { wakeWhen: { command: wakeWhen.command, pid: null } } : {}),
    };
  });

  app.post('/api/callbacks/complete-managed-hold', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (!deps.managedHoldDispositionService) {
      reply.status(503);
      return { error: 'Managed hold disposition unavailable', code: 'MANAGED_HOLD_DISPOSITION_UNAVAILABLE' };
    }
    const parsed = z
      .object({ disposition: z.enum(['handled', 'completed']) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    try {
      return await deps.managedHoldDispositionService.complete(record, parsed.data.disposition);
    } catch (error) {
      if (error instanceof ManagedHoldDispositionError) {
        reply.status(409);
        return { error: 'Managed hold disposition rejected', code: error.code };
      }
      throw error;
    }
  });

  app.post('/api/callbacks/complete-a2a-dispatch', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (!deps.a2aDispatchDispositionService) {
      reply.status(503);
      return { error: 'A2A dispatch disposition unavailable', code: 'A2A_DISPATCH_DISPOSITION_UNAVAILABLE' };
    }
    const parsed = z
      .object({ disposition: z.enum(['handled', 'completed']) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    try {
      return await deps.a2aDispatchDispositionService.complete(record, parsed.data.disposition);
    } catch (error) {
      if (error instanceof A2ADispatchDispositionError) {
        reply.status(409);
        return {
          error: 'A2A dispatch disposition rejected',
          code: error.code,
          ...(error.replacement ? { replacement: error.replacement } : {}),
        };
      }
      throw error;
    }
  });

  registerHoldBallCancelRoutes(app, deps);
}
