/**
 * Multi-Mention Callback Routes (F086 M1)
 *
 * POST /api/callbacks/multi-mention — Create + dispatch multi-cat question
 * GET  /api/callbacks/multi-mention-status — Poll request status
 */

import {
  actionSuccessorMetadataSchema,
  type CatId,
  catRegistry,
  createCatId,
  DEFAULT_TIMEOUT_MINUTES,
} from '@cat-cafe/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type ActionSuccessorAdmissionService,
  type ActionSuccessorFence,
  buildActionSuccessorFence,
} from '../domains/ball-custody/ActionSuccessorAdmissionService.js';
import {
  type ActionSuccessorCarrierAdmissionOutcome,
  type ActionSuccessorCarrierDisposition,
  actionSuccessorFencesMatch,
  reconcileActionSuccessorEnqueue,
} from '../domains/ball-custody/reconcile-action-successor-enqueue.js';
import {
  type InvocationQueue,
  queueEntryTargetCats,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import {
  type MultiMentionCreateParams,
  MultiMentionOrchestrator,
} from '../domains/cats/services/agents/routing/MultiMentionOrchestrator.js';
import type { CloudDispatchProvenance } from '../domains/cats/services/cloud-bridge/types.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import { messageFrom } from '../domains/cats/services/stores/message-from.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  type AppendMessageInput,
  type IMessageStore,
  isDelivered,
  type StoredMessage,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import type {
  ITurnExecutionStore,
  TurnExecutionRecord,
} from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { canViewMessage, resolveVisibleReplyParent } from '../domains/cats/services/stores/visibility.js';
import {
  protocolActionWithoutCustodyTotal,
  successorActionFenceUnavailable,
  successorMultiMentionTotal,
  successorSingleTargetMultiMention,
  successorUnfencedSingleTargetMultiMention,
} from '../infrastructure/telemetry/instruments.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import {
  type A2AFanoutAdmissionPlan,
  type A2ATriggerDeps,
  appendA2ASourceWithLedgerAdmission,
  enqueueA2ATargets,
  preflightA2ATargets,
} from './callback-a2a-trigger.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { resolveCallbackActionLeaseRef } from './callback-scope-helpers.js';

// ── Singleton orchestrator ───────────────────────────────────────────
let globalOrchestrator: MultiMentionOrchestrator | undefined;

export function getMultiMentionOrchestrator(): MultiMentionOrchestrator {
  if (!globalOrchestrator) globalOrchestrator = new MultiMentionOrchestrator();
  return globalOrchestrator;
}

/** For test reset */
export function resetMultiMentionOrchestrator(): void {
  globalOrchestrator = undefined;
}

export function classifyMultiMentionCarrierUsage(input: { targetCount: number; hasAction: boolean }): {
  singleTarget: boolean;
  unfencedSingleTarget: boolean;
} {
  const singleTarget = input.targetCount === 1;
  return { singleTarget, unfencedSingleTarget: singleTarget && !input.hasAction };
}

function multiMentionIntent(question: string, context: string | undefined): string {
  return [question, ...(context ? ['---', context] : [])].join('\n\n');
}

async function resolveCloudDispatchProvenance(input: {
  record: InvocationRecord;
  messageStore: IMessageStore;
  question: string;
  context: string | undefined;
  log: FastifyBaseLogger;
}): Promise<CloudDispatchProvenance | undefined> {
  const sourceMessageId = input.record.originTriggerMessageId ?? input.record.a2aTriggerMessageId;
  if (!sourceMessageId) {
    input.log.warn(
      { invocationId: input.record.invocationId },
      '[F247] multi-mention exact source provenance unavailable',
    );
    return undefined;
  }

  let source: StoredMessage | null;
  try {
    source = await resolveVisibleReplyParent(input.messageStore, sourceMessageId, {
      threadId: input.record.threadId,
      viewer: { type: 'cat', catId: createCatId('gpt-pro') },
      publicReply: true,
    });
  } catch (err) {
    input.log.warn(
      { invocationId: input.record.invocationId, sourceMessageId, err },
      '[F247] multi-mention exact source lookup failed closed',
    );
    return undefined;
  }
  if (
    !source ||
    source.id !== sourceMessageId ||
    source.threadId !== input.record.threadId ||
    source.userId !== input.record.userId ||
    source.deletedAt ||
    !isDelivered(source) ||
    source.userId === 'system' ||
    source.catId === 'system' ||
    source.origin === 'briefing' ||
    !canViewMessage(source, { type: 'cat', catId: input.record.catId })
  ) {
    input.log.warn(
      { invocationId: input.record.invocationId, sourceMessageId },
      '[F247] multi-mention exact source failed scope or public-return eligibility validation',
    );
    return undefined;
  }

  const sourceSender: CloudDispatchProvenance['sourceSender'] = source.catId
    ? {
        kind: 'cat',
        id: source.catId,
        ...(source.extra?.stream?.turnInvocationId
          ? { invocationId: source.extra.stream.turnInvocationId }
          : source.extra?.stream?.invocationId
            ? { invocationId: source.extra.stream.invocationId }
            : {}),
      }
    : { kind: 'user', id: source.userId };
  return {
    sourceMessageId,
    sourceSender,
    calledByCatId: input.record.catId,
    intent: multiMentionIntent(input.question, input.context),
  };
}

// ── Schema ───────────────────────────────────────────────────────────
const multiMentionSchema = z
  .object({
    targets: z.array(z.string().min(1)).min(1).max(3),
    question: z.string().min(1).max(5000),
    callbackTo: z.string().min(1),
    context: z.string().max(5000).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    timeoutMinutes: z.number().int().min(3).max(20).optional(),
    searchEvidenceRefs: z.array(z.string()).optional(),
    overrideReason: z.string().min(1).max(500).optional(),
    triggerType: z.string().optional(),
    action: actionSuccessorMetadataSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.action) return;
    if (value.action.actionFamily === 'review') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message:
          'Local review uses ordinary durable A2A delivery with localReviewVerdict, reviewedHeadSha, and accepted-source fields, not multi_mention action custody.',
      });
    }
    if (!value.idempotencyKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idempotencyKey'], message: 'required with action metadata' });
    }
    if (value.action.mode === 'single' && value.targets.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: 'single action requires exactly one target',
      });
    }
    if (value.action.mode === 'parallel' && !value.action.returnToPredecessor && value.targets.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: 'parallel action requires at least two targets',
      });
    }
    if (value.action.mode === 'parallel' && value.action.returnToPredecessor && value.targets.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: 'parallel rejected-ownership disposition requires one predecessor target',
      });
    }
    if (value.action.mode === 'parallel' && !value.action.parallelIntent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'parallelIntent'],
        message: 'parallel action requires explicit parallel intent',
      });
    }
  });

const multiMentionStatusSchema = z.object({
  requestId: z.string().min(1),
});

// ── Deps ─────────────────────────────────────────────────────────────
export interface MultiMentionRouteDeps {
  messageStore: IMessageStore;
  socketManager: SocketManager;
  router: AgentRouter;
  invocationRecordStore: IInvocationRecordStore;
  invocationTracker?: InvocationTracker | undefined;
  /** Durable prompt-causality truth for the callback child. */
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
  /** F167 Phase S: durable subject/action/slot single-flight admission. */
  actionSuccessorAdmissionService?: Pick<
    ActionSuccessorAdmissionService,
    'admit' | 'markUnavailable' | 'markReturnedDelivered'
  >;
  /** F293: fresh routing policy at the actual Queue admission boundary. */
  routingDispatchPreflight?: A2ATriggerDeps['routingDispatchPreflight'];
  /** F122B B6: InvocationQueue for unified dispatch */
  invocationQueue?: A2ATriggerDeps['invocationQueue'] &
    Pick<InvocationQueue, 'hasQueuedAgentForCat' | 'getQueuedFreshnessMessagesForCat'>;
  /** F122B B6: QueueProcessor for execution + response hook */
  queueProcessor?: {
    requestDrain?(threadId: string): Promise<void>;
    registerEntryCompleteHook?(
      entryId: string,
      hook: (
        entryId: string,
        status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
        responseText: string,
      ) => void,
      targetCatId?: string,
    ): void;
    unregisterEntryCompleteHook?(entryId: string): void;
    markPromptMessagesSeen?(input: {
      threadId: string;
      userId: string;
      catId: string;
      invocationId: string;
      messageIds: readonly string[];
    }): Promise<void>;
  };
}

// ── Timeout tracking ────────────────────────────────────────────────
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleTimeout(
  requestId: string,
  timeoutMinutes: number,
  log: FastifyBaseLogger,
  onTimeout?: () => Promise<void>,
): void {
  const ms = timeoutMinutes * 60_000;
  const timer = setTimeout(() => {
    const orch = getMultiMentionOrchestrator();
    log.info({ requestId, timeoutMinutes }, '[F086] Multi-mention timeout fired');
    orch.handleTimeout(requestId);
    activeTimers.delete(requestId);
    if (onTimeout) {
      void onTimeout().catch((err) => {
        log.error({ err, requestId }, '[F167-S] failed to mark timed-out action successors unavailable');
      });
    }
  }, ms);
  // Unref so it doesn't keep the process alive
  timer.unref();
  activeTimers.set(requestId, timer);
}

function cancelTimeout(requestId: string): void {
  const timer = activeTimers.get(requestId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(requestId);
  }
}

function registerMultiMentionCompletionHook(input: {
  deps: MultiMentionRouteDeps;
  queueProcessor: NonNullable<MultiMentionRouteDeps['queueProcessor']>;
  entryId: string;
  requestId: string;
  catId: CatId;
  threadId: string;
  userId: string;
  log: FastifyBaseLogger;
}): void {
  const orch = getMultiMentionOrchestrator();
  input.queueProcessor.registerEntryCompleteHook?.(
    input.entryId,
    (_entryId, status, responseText) => {
      if (status === 'canceled' || status === 'canceled_by_user') {
        input.log.info(
          { requestId: input.requestId, catId: input.catId },
          '[F122B B6] multi-mention queue entry canceled, skipping recordResponse',
        );
        return;
      }
      const finalResponse = responseText || (status === 'failed' ? '[dispatch error]' : '');
      const newStatus = orch.recordResponse(input.requestId, input.catId, finalResponse);
      input.log.info(
        { requestId: input.requestId, catId: input.catId, newStatus, responseLength: finalResponse.length },
        '[F122B B6] multi-mention queue response recorded',
      );
      settleGroupIfComplete(input.deps, input.requestId, input.threadId, input.userId, input.log);
    },
    input.catId,
  );
}

function planMultiMentionFanout(input: {
  invocationQueue: NonNullable<MultiMentionRouteDeps['invocationQueue']>;
  targetCatIds: readonly CatId[];
  requestedTargetCatIds?: readonly CatId[];
  threadId: string;
  actionFence: ActionSuccessorFence | undefined;
}): A2AFanoutAdmissionPlan {
  const MAX_MM_DEPTH = 10;
  const acceptedTargetCats: CatId[] = [];
  const predictedDepth = input.invocationQueue.countAgentEntriesForThread(input.threadId);
  let stop: A2AFanoutAdmissionPlan['stop'];
  for (const catId of input.targetCatIds) {
    if (predictedDepth >= MAX_MM_DEPTH) {
      stop = { reason: 'depth', catId, currentDepth: predictedDepth };
      break;
    }
    if (!input.actionFence && input.invocationQueue.hasQueuedAgentForCat(input.threadId, catId)) continue;
    acceptedTargetCats.push(catId);
  }
  return {
    requestedTargetCats: [...(input.requestedTargetCatIds ?? input.targetCatIds)],
    acceptedTargetCats,
    streakTargetCats: [],
    ...(stop ? { stop } : {}),
  };
}

async function resolveMultiMentionSourceMessage(
  deps: MultiMentionRouteDeps,
  input: { invocationId: string; callerCatId: CatId; threadId: string; userId: string },
): Promise<StoredMessage | null> {
  const source = await deps.messageStore.getByIdempotencyKey(
    input.userId,
    input.threadId,
    `message-lifecycle-response:${input.invocationId}`,
  );
  const from = source ? messageFrom(source) : null;
  if (
    !source ||
    source.threadId !== input.threadId ||
    source.userId !== input.userId ||
    from?.kind !== 'agent' ||
    from.catId !== input.callerCatId ||
    source.lifecycle?.kind !== 'response' ||
    source.lifecycle.invocationId !== input.invocationId ||
    source.deliveryStatus === 'canceled' ||
    source.visibility === 'whisper' ||
    source.recall ||
    source._tombstone
  ) {
    return null;
  }
  return source;
}

// ── Dispatch via InvocationQueue (F122B B6) ─────────────────────────
async function dispatchViaQueue(
  deps: MultiMentionRouteDeps,
  requestId: string,
  targetCatIds: CatId[],
  question: string,
  context: string | undefined,
  threadId: string,
  userId: string,
  ownerAuthProvenance: OwnerAuthProvenance,
  initiator: CatId,
  cloudDispatchProvenance: CloudDispatchProvenance | undefined,
  log: FastifyBaseLogger,
  sourceMessage: StoredMessage,
  parentInvocationId: string,
  actionFence?: ActionSuccessorFence,
  actionCarrierDisposition?: ActionSuccessorCarrierDisposition,
): Promise<void> {
  const { invocationQueue, queueProcessor } = deps;
  if (!invocationQueue || !queueProcessor) return;

  const messageContent = [`[Multi-Mention from ${initiator}]`, question, ...(context ? ['---', context] : [])].join(
    '\n\n',
  );

  // Resolve routing before publishing the source so Message + pending Queue targets
  // are committed as one fact. The lifecycle response that invoked this tool remains
  // the causal parent; it must not impersonate a different synthetic Queue body.
  const routingPreflight = await preflightA2ATargets(
    deps.routingDispatchPreflight ? { routingDispatchPreflight: deps.routingDispatchPreflight } : {},
    { targetCats: targetCatIds, content: messageContent, userId },
  );
  const preplannedAdmission = planMultiMentionFanout({
    invocationQueue,
    targetCatIds: routingPreflight.acceptedTargetCats,
    requestedTargetCatIds: routingPreflight.requestedTargetCats,
    threadId,
    actionFence,
  });
  const sourceInput: AppendMessageInput = {
    from: { kind: 'agent', catId: initiator },
    userId,
    threadId,
    content: messageContent,
    mentions: [...targetCatIds],
    replyTo: sourceMessage.id,
    origin: 'callback',
    timestamp: Date.now(),
    idempotencyKey: `multi-mention-source:${requestId}`,
    extra: {
      isExplicitPost: true,
      causal: { kind: 'invocation_reply', triggerMessageId: sourceMessage.id },
    },
  };
  const atomicAdmission = await appendA2ASourceWithLedgerAdmission(
    { messageStore: deps.messageStore, invocationQueue },
    sourceInput,
    {
      plan: preplannedAdmission,
      ownerAuthProvenance,
      parentInvocationId,
      ...(actionFence ? { actionSuccessorFence: actionFence } : {}),
      ...(cloudDispatchProvenance ? { cloudDispatchProvenance } : {}),
      requiresExactCloudDispatchProvenance: true,
    },
  );
  const result = await enqueueA2ATargets(
    {
      socketManager: deps.socketManager,
      invocationTracker: deps.invocationTracker,
      queueProcessor,
      messageStore: deps.messageStore,
      invocationQueue,
      ...(deps.routingDispatchPreflight ? { routingDispatchPreflight: deps.routingDispatchPreflight } : {}),
      log,
    },
    {
      targetCats: targetCatIds,
      content: messageContent,
      userId,
      ownerAuthProvenance,
      threadId,
      triggerMessage: atomicAdmission.message,
      callerCatId: initiator,
      parentInvocationId,
      preplannedAdmission,
      ...(routingPreflight.decision ? { routingPreflightDecision: routingPreflight.decision } : {}),
      ...(atomicAdmission.preAdmittedEntries
        ? {
            preAdmittedEntries: atomicAdmission.preAdmittedEntries,
            preAdmittedReplayed: atomicAdmission.preAdmittedReplayed,
          }
        : {}),
      ...(cloudDispatchProvenance ? { cloudDispatchProvenance } : {}),
      requiresExactCloudDispatchProvenance: true,
      ...(actionFence ? { actionSuccessorFence: actionFence } : {}),
      onQueueEntriesAdmitted: (entries) => {
        for (const entry of entries) {
          for (const catId of queueEntryTargetCats(entry)) {
            registerMultiMentionCompletionHook({
              deps,
              queueProcessor,
              entryId: entry.id,
              requestId,
              catId: catId as CatId,
              threadId,
              userId,
              log,
            });
          }
        }
      },
    },
  );
  const admitted = [...result.enqueued, ...(result.coalesced ?? [])];
  const unavailable = targetCatIds.filter((catId) => !admitted.includes(catId));

  await reconcileActionSuccessorEnqueue({
    service: deps.actionSuccessorAdmissionService,
    fence: actionFence,
    disposition: actionCarrierDisposition,
    unavailableCatIds: unavailable,
    now: Date.now(),
  });

  // Same-class sweep after 砚砚 R4: a target rejected at admission can NEVER produce a response, so
  // the orchestrator has to hear about it or the whole group sits at `partial` until the timeout.
  // R4 fixed exactly this on the legacy path; the Queue path had the identical hole, where
  // `skipped` / `depth_limited` only fed the action-lease reconciliation.
  const orch = getMultiMentionOrchestrator();
  const rejected = targetCatIds.filter((catId) => !admitted.includes(catId));
  for (const catId of rejected) {
    orch.recordResponse(requestId, catId, '[dispatch unavailable: target was not admitted to the queue]');
  }
  if (rejected.length > 0) settleGroupIfComplete(deps, requestId, threadId, userId, log);
}

// ── Result flush ─────────────────────────────────────────────────────
/**
 * INV-2 HOLDER — the ONLY place a multi-mention group may settle.
 *
 * State machine this owns:
 *   group: open -> settling -> flushed        (never "waiting for the timeout to notice")
 *
 * Five review rounds produced the same class of defect at four different call sites: a branch
 * decided on its own whether the group was done, cancelled the timer itself, and fired
 * `flushResult` as a bare `void` — so a failing store surfaced as an unhandledRejection (砚砚 R5
 * measured it: HTTP 200, then `unhandledRejection("flush store unavailable")`, and production has
 * no global handler). Each round fixed one site and the next round's new branch copied the hole
 * again. Enumerating branches loses to branches being added; owning the transition does not.
 *
 * Callers now state only WHAT happened (a response was recorded, targets were rejected); this
 * function decides whether that completes the group. Detached by design — settling is downstream
 * of custody and must never gate a dispatch — but never unguarded.
 */
function settleGroupIfComplete(
  deps: MultiMentionRouteDeps,
  requestId: string,
  threadId: string,
  userId: string,
  log: FastifyBaseLogger,
): void {
  const orch = getMultiMentionOrchestrator();
  if (orch.getStatus(requestId) !== 'done') return;
  cancelTimeout(requestId);
  void flushResult(deps, requestId, threadId, userId, log).catch((err) => {
    // A summary write failure must not take the process down, and must not be silent either:
    // the group is terminal, what got lost is its aggregate.
    log.error(
      { requestId, threadId, err: err instanceof Error ? err.message : String(err) },
      '[F086] Multi-mention result flush failed — group is settled but its summary was not persisted',
    );
  });
}

async function flushResult(
  deps: MultiMentionRouteDeps,
  requestId: string,
  threadId: string,
  userId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const orch = getMultiMentionOrchestrator();
  const result = orch.getResult(requestId);
  const { messageStore, socketManager } = deps;

  // Build aggregated result message
  const lines: string[] = [`## Multi-Mention 结果汇总`, '', `**问题**: ${result.request.question}`, ''];

  for (const resp of result.responses) {
    const entry = catRegistry.tryGet(resp.catId);
    const catName = entry?.config.displayName ?? resp.catId;
    if (resp.status === 'received') {
      lines.push(`### ${catName}`);
      lines.push(resp.content || '(空回答)');
      lines.push('');
    } else {
      lines.push(`### ${catName} — ${resp.status === 'timeout' ? '超时' : '失败'}`);
      lines.push('');
    }
  }

  const content = lines.join('\n');

  // F098-C2: Include initiator + targets metadata for frontend direction rendering
  const connectorSource = {
    connector: 'multi-mention-result' as const,
    label: 'Multi-Mention 结果',
    icon: 'users',
    meta: {
      initiator: result.request.callbackTo,
      targets: [...result.request.targets],
    },
  };

  // Post aggregated result to thread (with source for persistence)
  const stored = await messageStore.append({
    from: { kind: 'external', connectorId: 'multi-mention-result' },
    userId,
    content,
    mentions: [],
    timestamp: Date.now(),
    threadId,
    source: connectorSource,
  });

  socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
    threadId,
    message: {
      id: stored.id,
      type: 'connector',
      content,
      source: connectorSource,
      timestamp: stored.timestamp,
    },
  });

  log.info(
    {
      requestId,
      threadId,
      status: result.request.status,
      responseCount: result.responses.filter((r) => r.status === 'received').length,
      totalTargets: result.request.targets.length,
    },
    '[F086] Multi-mention result flushed',
  );
}

// ── Route registration ───────────────────────────────────────────────
export function registerMultiMentionRoutes(app: FastifyInstance, deps: MultiMentionRouteDeps): void {
  // POST /api/callbacks/multi-mention
  app.post<{ Body: z.infer<typeof multiMentionSchema> }>('/api/callbacks/multi-mention', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsedBody = multiMentionSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ status: 'invalid_request', issues: parsedBody.error.issues });
    }
    const body = parsedBody.data;
    const carrierUsage = classifyMultiMentionCarrierUsage({
      targetCount: body.targets.length,
      hasAction: body.action !== undefined,
    });
    successorMultiMentionTotal.add(1);
    if (carrierUsage.singleTarget) successorSingleTargetMultiMention.add(1);
    if (carrierUsage.unfencedSingleTarget) successorUnfencedSingleTargetMultiMention.add(1);

    // F182 AC-C2: A' class — validate targets + callbackTo are available (contract 400 on disabled)
    const targetCatIds: CatId[] = [];
    for (const target of body.targets) {
      const resolved = resolveCatTarget(target);
      if ('error' in resolved) {
        // cat_disabled: return full CatRoutingError (F182 AC-C2 contract, checked by C2-e)
        // cat_not_found: backward-compat { error: 'Unknown cat: ...' } (pre-existing contract)
        if (resolved.error.kind === 'cat_disabled') return reply.status(400).send(resolved.error);
        return reply.status(400).send({ error: `Unknown cat: ${target}` });
      }
      targetCatIds.push(createCatId(resolved.ok));
    }

    // Validate callbackTo
    const callbackToResolved = resolveCatTarget(body.callbackTo);
    if ('error' in callbackToResolved) {
      if (callbackToResolved.error.kind === 'cat_disabled') return reply.status(400).send(callbackToResolved.error);
      return reply.status(400).send({ error: `Unknown callbackTo cat: ${body.callbackTo}` });
    }

    const orch = getMultiMentionOrchestrator();
    const callerCatId = record.catId;
    const expectedParentInvocationId = record.parentInvocationId ?? record.invocationId;

    let turnExecution: TurnExecutionRecord | null = null;
    if (deps.turnExecutionStore) {
      try {
        turnExecution = await deps.turnExecutionStore.get(record.invocationId);
      } catch (err) {
        request.log.error(
          { err, invocationId: record.invocationId },
          '[turn-execution] multi-mention ledger read failed',
        );
        return reply.status(503).send({ status: 'turn_execution_ledger_unavailable' });
      }
      if (!turnExecution) {
        return reply.status(409).send({ status: 'turn_execution_not_found' });
      }
      if (
        turnExecution.status !== 'running' ||
        turnExecution.threadId !== record.threadId ||
        turnExecution.userId !== record.userId ||
        turnExecution.catId !== callerCatId ||
        turnExecution.parentInvocationId !== expectedParentInvocationId
      ) {
        request.log.error(
          { invocationId: record.invocationId, expectedParentInvocationId, turnExecution },
          '[turn-execution] multi-mention auth/ledger scope mismatch',
        );
        return reply.status(409).send({ status: 'turn_execution_scope_mismatch' });
      }
    }

    // Anti-cascade guard: reject if caller is a target in an active multi-mention
    if (orch.isActiveTarget(record.threadId, callerCatId)) {
      return reply.status(409).send({
        error: 'Anti-cascade: caller is an active multi-mention target',
        hint: 'Cannot create multi-mention while responding to one',
      });
    }

    let actionFence: ActionSuccessorFence | undefined;
    let actionAdmissionOutcome: ActionSuccessorCarrierAdmissionOutcome | undefined;
    const actionCarrierDisposition: ActionSuccessorCarrierDisposition | undefined = body.action
      ? body.action.returnToPredecessor
        ? 'return'
        : 'successor_dispatch'
      : undefined;
    if (body.action) {
      if (!deps.actionSuccessorAdmissionService || !deps.invocationQueue || !deps.queueProcessor) {
        successorActionFenceUnavailable.add(1);
        protocolActionWithoutCustodyTotal.add(1);
        return reply.status(503).send({ status: 'action_fence_unavailable' });
      }
      try {
        const incomingActionLeaseRef = body.action.replace
          ? await resolveCallbackActionLeaseRef(record, deps.invocationRecordStore)
          : undefined;
        const admission = await deps.actionSuccessorAdmissionService.admit({
          tenantScope: record.userId,
          actorCatId: callerCatId,
          sourceThreadId: record.threadId,
          targetThreadId: record.threadId,
          holderCatIds: targetCatIds,
          dispatchId: `multi-mention:${body.idempotencyKey}`,
          evidenceRef: `callback:${record.invocationId}:${body.idempotencyKey}`,
          now: Date.now(),
          ...(incomingActionLeaseRef ? { incomingActionLeaseRef } : {}),
          action: body.action,
        });
        if (!admission.admit) {
          if (admission.outcome === 'subject_terminal') {
            return reply.send({ status: admission.outcome, terminal: admission.terminal });
          }
          if (admission.outcome === 'safe_wait') {
            return reply.status(409).send({
              status: 'action_carrier_unavailable',
              reason: 'carrier_missing',
              actionLease: admission.lease,
            });
          }
          if (admission.outcome !== 'replayed') {
            return reply.send({ status: admission.outcome, actionLease: admission.lease });
          }
          actionAdmissionOutcome = 'replayed';
          actionFence = buildActionSuccessorFence(admission.lease, `multi-mention:${body.idempotencyKey}`);
        } else {
          actionAdmissionOutcome = admission.outcome;
          actionFence = admission.fence;
        }
      } catch (err) {
        request.log.warn({ err, action: body.action }, '[F167-S] invalid action successor admission');
        return reply
          .status(400)
          .send({ status: 'invalid_action', error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (!deps.invocationQueue || !deps.queueProcessor?.requestDrain) {
      return reply.code(503).send({ error: 'Multi-mention dispatch requires InvocationQueue and QueueProcessor' });
    }

    const sourceMessage = await resolveMultiMentionSourceMessage(deps, {
      invocationId: record.invocationId,
      callerCatId,
      threadId: record.threadId,
      userId: record.userId,
    });
    if (!sourceMessage) {
      return reply.code(409).send({ status: 'lifecycle_source_unavailable' });
    }

    const createParams = {
      threadId: record.threadId,
      initiator: callerCatId,
      callbackTo: createCatId(callbackToResolved.ok),
      targets: targetCatIds,
      question: body.question,
      timeoutMinutes: body.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
      ...(body.context ? { context: body.context } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      ...(body.triggerType ? { triggerType: body.triggerType as MultiMentionCreateParams['triggerType'] } : {}),
      ...(body.searchEvidenceRefs ? { searchEvidenceRefs: body.searchEvidenceRefs } : {}),
      ...(body.overrideReason ? { overrideReason: body.overrideReason } : {}),
    } satisfies MultiMentionCreateParams;

    const cloudDispatchProvenance = await resolveCloudDispatchProvenance({
      record,
      messageStore: deps.messageStore,
      question: body.question,
      context: body.context,
      log: request.log,
    });

    const mmRequest = orch.create(createParams);

    // If already created (idempotency), return existing
    if (mmRequest.status !== 'pending') {
      if (actionFence && actionCarrierDisposition === 'return') {
        const accepted =
          deps.invocationQueue
            ?.list(record.threadId, record.userId)
            .some((entry) => actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, actionFence)) ?? false;
        await reconcileActionSuccessorEnqueue({
          service: deps.actionSuccessorAdmissionService,
          fence: actionFence,
          disposition: actionCarrierDisposition,
          unavailableCatIds: accepted ? [] : targetCatIds,
          now: Date.now(),
        });
      }
      return reply.send({ requestId: mmRequest.id, status: mmRequest.status });
    }

    // Start + schedule timeout
    orch.start(mmRequest.id);
    const actionAdmissionService = deps.actionSuccessorAdmissionService;
    scheduleTimeout(
      mmRequest.id,
      mmRequest.timeoutMinutes,
      request.log,
      actionFence && actionCarrierDisposition !== 'return' && actionAdmissionService
        ? () =>
            actionAdmissionService.markUnavailable({
              fence: actionFence,
              holderCatIds: targetCatIds,
              evidenceRef: `timeout:${actionFence.dispatchId}`,
              now: Date.now(),
            })
        : undefined,
    );

    await dispatchViaQueue(
      deps,
      mmRequest.id,
      targetCatIds,
      body.question,
      body.context,
      record.threadId,
      record.userId,
      record.ownerAuthProvenance,
      callerCatId,
      cloudDispatchProvenance,
      request.log,
      sourceMessage,
      expectedParentInvocationId,
      actionFence,
      actionCarrierDisposition,
    );

    request.log.info(
      {
        requestId: mmRequest.id,
        targets: body.targets,
        callbackTo: body.callbackTo,
        timeoutMinutes: mmRequest.timeoutMinutes,
        triggerType: body.triggerType,
        hasSearchEvidence: Boolean(body.searchEvidenceRefs?.length),
        hasOverrideReason: Boolean(body.overrideReason),
      },
      '[F086] Multi-mention request created + dispatched',
    );

    return reply.send({
      requestId: mmRequest.id,
      status: mmRequest.status,
      ...(actionFence && actionAdmissionOutcome
        ? {
            actionLease: {
              leaseId: actionFence.leaseId,
              generation: actionFence.generation,
              outcome: actionAdmissionOutcome,
            },
          }
        : {}),
    });
  });

  // GET /api/callbacks/multi-mention-status
  app.get<{ Querystring: z.infer<typeof multiMentionStatusSchema> }>(
    '/api/callbacks/multi-mention-status',
    async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;

      const query = multiMentionStatusSchema.parse(request.query);

      const orch = getMultiMentionOrchestrator();
      try {
        const result = orch.getResult(query.requestId);
        return reply.send({
          requestId: query.requestId,
          status: result.request.status,
          responses: result.responses.map((r) => ({
            catId: r.catId,
            status: r.status,
            contentLength: r.content.length,
          })),
        });
      } catch {
        return reply.status(404).send({ error: 'Multi-mention request not found' });
      }
    },
  );
}
