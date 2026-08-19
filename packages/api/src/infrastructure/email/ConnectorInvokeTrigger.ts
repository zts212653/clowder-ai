/**
 * Connector Invoke Trigger
 * Programmatically triggers a cat invocation after a connector message is posted.
 *
 * Phase 3b: Closes the loop — review email → connector message → cat invocation.
 * Uses the same AgentRouter pipeline as POST /api/messages but triggered
 * by the email watcher instead of an HTTP request.
 *
 * BACKLOG #97 Phase 3b
 */

import {
  type CatId,
  type MessageContent,
  type OutputCommitDecision,
  type WaitContinuationCarrierV1,
} from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultCatId } from '../../config/cat-config-loader.js';
import type { TurnCustodyWakeProvenance } from '../../domains/ball-custody/TurnCustodyProjectionService.js';
import {
  resolveQueueTurnCustodyWake,
  retargetTurnCustodyWake,
} from '../../domains/ball-custody/turn-custody-wake-provenance.js';
import {
  loadWaitContinuationCarrier,
  waitContinuationCarrierFromStoredMessage,
  waitContinuationCarriersMatch,
} from '../../domains/ball-custody/wait-continuation-carrier.js';
import type { InvocationQueue, QueueEntry } from '../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationTracker } from '../../domains/cats/services/agents/invocation/InvocationTracker.js';
import { PerCatTerminalDispositionCollector } from '../../domains/cats/services/agents/invocation/PerCatTerminalDispositionCollector.js';
import {
  createInitialQueuedMessageCustody,
  type QueuedMessageCustodyCoordinator,
} from '../../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { QueueProcessor } from '../../domains/cats/services/agents/invocation/QueueProcessor.js';
import { requireInvocationRecordUpdate } from '../../domains/cats/services/agents/invocation/require-invocation-record-update.js';
import { stampVisibleTurn } from '../../domains/cats/services/agents/invocation/visible-turn.js';
import type { AgentRouter } from '../../domains/cats/services/agents/routing/AgentRouter.js';
import {
  createA2ASlotTrackingBridge,
  type PersistenceContext,
} from '../../domains/cats/services/agents/routing/route-helpers.js';
import type {
  IInvocationRecordStore,
  InvocationRecord,
  InvocationStatus,
} from '../../domains/cats/services/stores/ports/InvocationRecordStore.js';
import { classifyInvocationRecoveryStatus } from '../../domains/cats/services/stores/ports/invocation-state-machine.js';
import type { IMessageStore, StoredMessage } from '../../domains/cats/services/stores/ports/MessageStore.js';
import { type AgentMessage, mergeTokenUsage, type TokenUsage } from '../../domains/cats/services/types.js';
import type { MemoryCueOpportunitySeed } from '../../domains/memory/cue/MemoryCueInvocationPromptService.js';
import { readTrustedConnectorMemoryCueSeeds } from '../../domains/memory/cue/MemoryCueTrustedConnector.js';
import { bindAsrPersonMemoryReentryFromSchedulerMessage } from '../../domains/memory/people/AsrPersonMemoryReentryCarrier.js';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { emitQueueUpdated, enrichQueueEntries } from '../../utils/queue-enrichment.js';

import type { OutboundDeliveryHook, ThreadMeta } from '../connectors/OutboundDeliveryHook.js';
import type { StreamingOutboundHook } from '../connectors/StreamingOutboundHook.js';

export type TriggerOutcome = 'dispatched' | 'enqueued' | 'full';

type DirectInvocationAdmission =
  | {
      readonly kind: 'execute';
      readonly invocationId: string;
      readonly expectedInitialStatus: Extract<InvocationStatus, 'queued' | 'failed'>;
    }
  | { readonly kind: 'acknowledged'; readonly invocationId: string; readonly status: 'running' | 'succeeded' };

interface ExecutionStartReceipt {
  readonly promise: Promise<void>;
  readonly accept: () => void;
  readonly reject: (reason: unknown) => void;
}

function createExecutionStartReceipt(): ExecutionStartReceipt {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    accept: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (reason) => {
      if (settled) return;
      settled = true;
      rejectPromise(reason);
    },
  };
}

function hasExecutionStartReceipt(record: InvocationRecord): boolean {
  return (
    typeof record.executionStartedAt === 'number' &&
    Number.isFinite(record.executionStartedAt) &&
    record.executionStartedAt > 0
  );
}

interface DurableChildExecutionStart {
  readonly childInvocationId: string;
  readonly startedAt: number;
}

function parseDurableChildExecutionStart(
  message: AgentMessage,
  expectedParentInvocationId: string,
): DurableChildExecutionStart | undefined {
  if (message.type !== 'system_info' || typeof message.content !== 'string') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const candidate = parsed as Record<string, unknown>;
  if (candidate.type !== 'invocation_created') return undefined;
  if (typeof candidate.invocationId !== 'string' || candidate.invocationId.trim().length === 0) return undefined;
  if (candidate.parentInvocationId !== expectedParentInvocationId) return undefined;
  if (typeof candidate.startedAt !== 'number' || !Number.isFinite(candidate.startedAt) || candidate.startedAt <= 0) {
    return undefined;
  }

  return {
    childInvocationId: candidate.invocationId,
    startedAt: candidate.startedAt,
  };
}

export interface ConnectorInvokeTriggerOptions {
  readonly router: AgentRouter;
  readonly socketManager: SocketManager;
  readonly invocationRecordStore: IInvocationRecordStore;
  readonly invocationTracker: InvocationTracker;
  readonly invocationQueue: InvocationQueue;
  readonly queueProcessor?: QueueProcessor;
  /** Gate 2: exact queued-source CAS used when recovery must replace an absent carrier. */
  readonly queueCustodyCoordinator?: QueuedMessageCustodyCoordinator;
  readonly outboundHook?: OutboundDeliveryHook;
  readonly streamingHook?: StreamingOutboundHook;
  readonly threadMetaLookup?: (threadId: string) => ThreadMeta | undefined | Promise<ThreadMeta | undefined>;
  /** Per-cat outbound deliver timeout in ms (default 10000). Prevents hanging deliver from blocking cleanup. */
  readonly deliverTimeoutMs?: number;
  /** #706: MessageStore for queue enrichment (messagePreview in queue_updated SSE). */
  readonly messageStore?: IMessageStore;
  readonly log: FastifyBaseLogger;
}

export interface ConnectorTriggerPolicy {
  /** F175: urgent entries get priority dequeue, no preemption */
  readonly priority?: 'urgent' | 'normal';
  /** optional reason for diagnostics */
  readonly reason?: string;
  /** F175: origin category for visual grouping */
  readonly sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
  /** F140 Phase C: hint which Skill to auto-load (not a hard constraint — cat can override) */
  readonly suggestedSkill?: string;
  /** Event carriers use the existing Queue/F254/F264 custody even when the thread is idle. */
  readonly forceQueue?: boolean;
  /**
   * Optional queue coalescing key for connector bursts that supersede earlier queued work.
   * Later hits reuse the first queued entry: messageIds are merged, but the original content/body stays in place.
   * Once that entry is already processing, follow-up feedback gets a fresh queued wake-up.
   * Queue metadata may still upgrade, e.g. normal COMMENTED feedback becoming urgent CHANGES_REQUESTED.
   */
  readonly coalesceKey?: string;
}

function isConnectorDeliverable(decision: OutputCommitDecision | undefined): boolean {
  return (
    decision === undefined ||
    decision.kind === 'committed_fresh' ||
    decision.kind === 'committed_degraded_unknown' ||
    decision.kind === 'published_with_unseen'
  );
}

/**
 * Invocation trigger for connector messages. The executor continues in the
 * background, but admission does not resolve until router startup has durable
 * evidence in the parent InvocationRecord.
 *
 * Flow:
 *   1. Create InvocationRecord (atomic)
 *   2. Start InvocationTracker
 *   3. Start routeExecution and persist its durable first-event receipt
 *   4. Continue routeExecution in background
 *   5. Broadcast agent messages to WebSocket room
 *   6. Ack cursor boundaries + update status
 */
export class ConnectorInvokeTrigger {
  private readonly opts: ConnectorInvokeTriggerOptions;

  constructor(opts: ConnectorInvokeTriggerOptions) {
    this.opts = opts;
  }

  /** Late-bind outbound hook (set after gateway bootstrap) */
  setOutboundHook(hook: OutboundDeliveryHook): void {
    (this.opts as { outboundHook?: OutboundDeliveryHook }).outboundHook = hook;
  }

  /** Late-bind streaming hook (set after gateway bootstrap) */
  setStreamingHook(hook: StreamingOutboundHook): void {
    (this.opts as { streamingHook?: StreamingOutboundHook }).streamingHook = hook;
  }

  /**
   * Trigger a cat invocation for a connector message.
   * Returns after durable execution-start acknowledgement; the remainder of
   * execution continues in the background.
   *
   * @param threadId  Thread where the connector message was posted
   * @param catId     Target cat to invoke
   * @param userId    User context for the invocation
   * @param message   The connector message content (used as invocation trigger)
   * @param messageId The stored connector message ID (for InvocationRecord backfill)
   */
  async trigger(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    contentBlocks?: readonly MessageContent[],
    policy?: ConnectorTriggerPolicy,
    sender?: { id: string; name?: string },
  ): Promise<TriggerOutcome> {
    const { invocationTracker } = this.opts;
    const priority = policy?.priority ?? 'normal';

    if (policy?.forceQueue) {
      const outcome = await this.enqueueWhileActive(
        threadId,
        catId,
        userId,
        message,
        messageId,
        sender,
        priority,
        policy.sourceCategory,
        policy.suggestedSkill,
        policy.coalesceKey,
        true,
      );
      if (outcome === 'enqueued') {
        const exactEntry = this.opts.invocationQueue.findEntryWithMessageId(threadId, messageId);
        if (exactEntry && (await this.isQueueEntryCustodyReady(exactEntry, messageId))) {
          await this.opts.queueProcessor?.tryAutoExecute(threadId, {
            bypassNonAgentGate: true,
            onlyEntryId: exactEntry.id,
          });
        }
      }
      return outcome;
    }

    // A cancel-all/force-reset owns the next terminal transition. Late managed
    // command or connector wakes remain durable in Queue instead of reviving
    // the just-reset slot through direct admission.
    if (this.opts.queueProcessor?.isAutoResumeSuppressed?.(threadId, catId)) {
      return this.enqueueWhileActive(
        threadId,
        catId,
        userId,
        message,
        messageId,
        sender,
        priority,
        policy?.sourceCategory,
        policy?.suggestedSkill,
        policy?.coalesceKey,
      );
    }

    // F185 AC-1: thread-level queue/processingSlots gate
    if (this.opts.queueProcessor?.isThreadBusy(threadId)) {
      return this.enqueueWhileActive(
        threadId,
        catId,
        userId,
        message,
        messageId,
        sender,
        priority,
        policy?.sourceCategory,
        policy?.suggestedSkill,
        policy?.coalesceKey,
      );
    }

    // F185 AC-2: atomic thread-level acquire — TOCTOU-safe
    const controller = invocationTracker.tryStartThread(threadId, catId, userId, [catId]);
    if (!controller) {
      return this.enqueueWhileActive(
        threadId,
        catId,
        userId,
        message,
        messageId,
        sender,
        priority,
        policy?.sourceCategory,
        policy?.suggestedSkill,
        policy?.coalesceKey,
      );
    }

    const releaseDirectAdmission = (): void => {
      invocationTracker.complete(threadId, catId, controller);
    };
    const rejectDirectAdmission = (): void => {
      releaseDirectAdmission();
      this.opts.queueProcessor?.onInvocationComplete(threadId, catId, 'failed', undefined, []).catch(() => {
        /* best-effort: release any queued work after rejected direct admission */
      });
    };

    let admission: DirectInvocationAdmission;
    try {
      admission = await this.admitDirectInvocation(threadId, catId, userId, messageId);
    } catch (err) {
      rejectDirectAdmission();
      this.opts.log.error(
        { err, threadId, catId, messageId },
        '[ConnectorInvokeTrigger] Durable invocation admission failed',
      );
      throw err;
    }

    if (admission.kind === 'acknowledged') {
      releaseDirectAdmission();
      return 'dispatched';
    }

    // AC-2+3: dispatch with acquired controller and atomically claimed durable record.
    // A running status is only the exclusive claim. Do not report `dispatched`
    // until the executor persists proof that router execution actually started.
    const executionStartReceipt = createExecutionStartReceipt();
    this.executeInBackground(
      threadId,
      catId,
      userId,
      message,
      messageId,
      admission.invocationId,
      contentBlocks,
      policy?.sourceCategory,
      policy?.suggestedSkill,
      sender,
      controller,
      executionStartReceipt,
    ).catch((err) => {
      executionStartReceipt.reject(err);
      this.opts.log.error(`[ConnectorInvokeTrigger] Unhandled: ${err instanceof Error ? err.message : String(err)}`);
    });
    await executionStartReceipt.promise;
    return 'dispatched';
  }

  private isExactConnectorRecord(
    record: InvocationRecord | null,
    expected: {
      threadId: string;
      userId: string;
      catId: CatId;
      messageId: string;
      waitContinuationCarrier?: WaitContinuationCarrierV1;
    },
  ): record is InvocationRecord {
    return (
      record !== null &&
      record.threadId === expected.threadId &&
      record.userId === expected.userId &&
      record.intent === 'execute' &&
      record.idempotencyKey === `connector-${expected.messageId}` &&
      record.targetCats.length === 1 &&
      record.targetCats[0] === expected.catId &&
      record.actionLeaseCarrier.kind === 'none' &&
      waitContinuationCarriersMatch(record.waitContinuationCarrier, expected.waitContinuationCarrier)
    );
  }

  private async admitDirectInvocation(
    threadId: string,
    catId: CatId,
    userId: string,
    messageId: string,
  ): Promise<DirectInvocationAdmission> {
    const waitContinuationCarrier = await loadWaitContinuationCarrier(this.opts.messageStore, messageId);
    // Admission is not accepted until the idempotent record exists and exactly
    // one worker has claimed queued -> running in the shared store.
    const createResult = await this.opts.invocationRecordStore.create({
      threadId,
      userId,
      targetCats: [catId],
      intent: 'execute',
      idempotencyKey: `connector-${messageId}`,
      actionLeaseCarrier: { kind: 'none' },
      ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
    });
    const invocationId = createResult.invocationId;
    let expectedInitialStatus: Extract<InvocationStatus, 'queued' | 'failed'> = 'queued';

    if (createResult.outcome === 'duplicate') {
      const existingRecord = await this.opts.invocationRecordStore.get(invocationId);
      if (
        !this.isExactConnectorRecord(existingRecord, {
          threadId,
          userId,
          catId,
          messageId,
          ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
        })
      ) {
        this.opts.log.warn(
          { threadId, catId, messageId, invocationId, status: 'missing' },
          '[ConnectorInvokeTrigger] Duplicate invocation identity was not accepted',
        );
        throw new Error(
          `Duplicate connector admission rejected: existing invocation ${invocationId} is missing or mismatched`,
        );
      }

      const recoveryStatus = classifyInvocationRecoveryStatus(existingRecord.status);
      switch (recoveryStatus) {
        case 'replayable':
          expectedInitialStatus = existingRecord.status as Extract<InvocationStatus, 'queued' | 'failed'>;
          this.opts.log.warn(
            { threadId, catId, messageId, invocationId, status: existingRecord.status },
            '[ConnectorInvokeTrigger] Recovering replayable duplicate before acknowledging dispatch',
          );
          break;
        case 'in_flight':
          if (!hasExecutionStartReceipt(existingRecord)) {
            this.opts.log.warn(
              { threadId, catId, messageId, invocationId, status: existingRecord.status },
              '[ConnectorInvokeTrigger] Running duplicate has no execution-start receipt',
            );
            throw new Error(
              `Duplicate connector admission rejected: existing invocation ${invocationId} is running without execution-start receipt`,
            );
          }
          this.opts.log.info(
            { threadId, catId, messageId, invocationId, status: existingRecord.status },
            '[ConnectorInvokeTrigger] Duplicate invocation already accepted',
          );
          return { kind: 'acknowledged', invocationId, status: 'running' };
        case 'completed':
          this.opts.log.info(
            { threadId, catId, messageId, invocationId, status: existingRecord.status },
            '[ConnectorInvokeTrigger] Duplicate invocation already accepted',
          );
          return {
            kind: 'acknowledged',
            invocationId,
            status: existingRecord.status as Extract<InvocationStatus, 'running' | 'succeeded'>,
          };
        case 'terminal':
          this.opts.log.warn(
            { threadId, catId, messageId, invocationId, status: existingRecord.status },
            '[ConnectorInvokeTrigger] Duplicate invocation was not accepted',
          );
          throw new Error(
            `Duplicate connector admission rejected: existing invocation ${invocationId} is ${existingRecord.status}`,
          );
      }
    }

    const claimedRecord = await this.opts.invocationRecordStore.update(invocationId, {
      userMessageId: messageId,
      status: 'running',
      expectedStatus: expectedInitialStatus,
      ...(expectedInitialStatus === 'failed' ? { error: '' } : {}),
    });
    if (claimedRecord) return { kind: 'execute', invocationId, expectedInitialStatus };

    const currentRecord = await this.opts.invocationRecordStore.get(invocationId);
    switch (currentRecord?.status) {
      case 'running':
        if (!hasExecutionStartReceipt(currentRecord)) {
          this.opts.log.warn(
            { threadId, catId, messageId, invocationId, status: currentRecord.status },
            '[ConnectorInvokeTrigger] Invocation claim winner has not started execution',
          );
          throw new Error(
            `Duplicate connector admission rejected: existing invocation ${invocationId} is running without execution-start receipt`,
          );
        }
        this.opts.log.info(
          { threadId, catId, messageId, invocationId, status: currentRecord.status },
          '[ConnectorInvokeTrigger] Another worker accepted the invocation',
        );
        return { kind: 'acknowledged', invocationId, status: currentRecord.status };
      case 'succeeded':
        this.opts.log.info(
          { threadId, catId, messageId, invocationId, status: currentRecord.status },
          '[ConnectorInvokeTrigger] Another worker accepted the invocation',
        );
        return { kind: 'acknowledged', invocationId, status: currentRecord.status };
    }

    const status = currentRecord ? currentRecord.status : 'missing';
    this.opts.log.warn(
      { threadId, catId, messageId, invocationId, status },
      '[ConnectorInvokeTrigger] Invocation claim was not accepted',
    );
    throw new Error(
      `Connector invocation ${invocationId} could not be claimed from ${expectedInitialStatus} (status: ${status})`,
    );
  }

  private async enqueueWhileActive(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    sender?: { id: string; name?: string },
    priority: 'urgent' | 'normal' = 'normal',
    sourceCategory?: string,
    suggestedSkill?: string,
    coalesceKey?: string,
    autoExecute = false,
  ): Promise<'full' | 'enqueued'> {
    const { invocationQueue, socketManager, log } = this.opts;

    const sourceMessage = await this.opts.messageStore?.getById(messageId);
    const waitContinuationCarrier = waitContinuationCarrierFromStoredMessage(sourceMessage);

    if (invocationQueue.hasEntryWithMessageId(threadId, messageId)) {
      log.info(
        { threadId, messageId },
        '[ConnectorInvokeTrigger] Duplicate connector message already queued, skipping',
      );
      return 'enqueued';
    }

    const custodyOwner = sourceMessage?.queueCustody?.ownerAuthProvenance;
    const result = invocationQueue.enqueue({
      threadId,
      userId,
      ownerAuthProvenance:
        custodyOwner === 'strict' || custodyOwner === 'compatibility_fallback' || custodyOwner === 'unknown'
          ? custodyOwner
          : 'unknown',
      content: message,
      messageId,
      ...(coalesceKey
        ? {
            idempotencyKey: `connector:${sourceCategory ?? 'generic'}:${coalesceKey}${
              waitContinuationCarrier
                ? `:wait:${waitContinuationCarrier.waitId}:${waitContinuationCarrier.outcomeId}`
                : ''
            }`,
            dedupeProcessing: false,
          }
        : {}),
      source: 'connector',
      targetCats: [catId],
      intent: 'execute',
      priority,
      autoExecute,
      ...(sourceCategory
        ? { sourceCategory: sourceCategory as 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue' }
        : {}),
      ...(sender ? { senderMeta: sender } : {}),
      ...(suggestedSkill ? { suggestedSkill } : {}),
      ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
    });

    if (result.outcome === 'full') {
      const fullQueue = await enrichQueueEntries(
        invocationQueue.list(threadId, userId),
        this.opts.messageStore ?? null,
      );
      socketManager.emitToUser(userId, 'queue_full_warning', {
        threadId,
        source: 'connector',
        queueSize: invocationQueue.size(threadId, userId),
        queue: fullQueue,
      });
      socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: getDefaultCatId(),
          content: JSON.stringify({ type: 'connector_skip', reason: 'queue_full', threadId }),
          timestamp: Date.now(),
        },
        threadId,
      );
      log.warn({ threadId, catId, userId }, '[ConnectorInvokeTrigger] Queue full, connector message not enqueued');
      return 'full';
    }

    if (result.entry) {
      // Initial admission stores the exact source atomically; coalesced replays
      // still append their distinct message IDs to the canonical carrier.
      invocationQueue.backfillMessageId(threadId, userId, result.entry.id, messageId);
      const persistedEntry = invocationQueue.getEntrySnapshot(threadId, userId, result.entry.id);
      if (persistedEntry && sourceMessage?.deliveryStatus === 'queued' && !sourceMessage.queueCustody) {
        const initialized = await this.opts.messageStore?.initializeQueueCustody(
          messageId,
          createInitialQueuedMessageCustody(persistedEntry),
        );
        if (initialized?.kind !== 'initialized' && initialized?.kind !== 'existing') {
          throw new Error(`connector Queue custody initialization failed for ${messageId}: ${initialized?.kind}`);
        }
      } else if (
        persistedEntry &&
        sourceMessage?.deliveryStatus === 'queued' &&
        sourceMessage.queueCustody &&
        sourceMessage.queueCustody.entryId !== persistedEntry.id
      ) {
        try {
          if (!this.opts.queueCustodyCoordinator) {
            throw new Error('Queue custody coordinator unavailable for verified replacement');
          }
          await this.opts.queueCustodyCoordinator.transferEntryCustody(persistedEntry, {
            kind: 'verified',
            previousEntryId: sourceMessage.queueCustody.entryId,
            replacementEntryId: persistedEntry.id,
            sourceMessageId: messageId,
          });
        } catch (error) {
          if (!result.deduped) invocationQueue.rollbackEnqueue(threadId, userId, persistedEntry.id);
          throw error;
        }
      }
    }

    await emitQueueUpdated(
      socketManager,
      userId,
      threadId,
      invocationQueue.list(threadId, userId),
      this.opts.messageStore ?? null,
      result.outcome,
    );
    log.info(
      { threadId, catId, outcome: result.outcome },
      '[ConnectorInvokeTrigger] Queued (active invocation running)',
    );
    return result.outcome;
  }

  /**
   * A recovery caller can observe a speculative replacement row while the first
   * caller is still committing its durable rebind. Only the caller that sees the
   * exact custody owner may publish that row to QueueProcessor.
   */
  private async isQueueEntryCustodyReady(entry: QueueEntry, sourceMessageId: string): Promise<boolean> {
    if (!this.opts.messageStore) return true;

    let sourceMessage: StoredMessage | null;
    try {
      sourceMessage = await this.opts.messageStore.getById(sourceMessageId);
    } catch (error) {
      this.opts.log.warn(
        { err: error, threadId: entry.threadId, queueEntryId: entry.id, sourceMessageId },
        '[ConnectorInvokeTrigger] Queue custody readiness lookup failed; deferring auto-execution',
      );
      return false;
    }
    if (!sourceMessage?.queueCustody) return true;
    if (sourceMessage.queueCustody.status === 'terminal') return false;

    const targetCarriers = sourceMessage.queueCustody.carrierByTargetCatId;
    return targetCarriers
      ? entry.targetCats.every((catId) => targetCarriers[catId]?.entryId === entry.id)
      : sourceMessage.queueCustody.entryId === entry.id;
  }

  private async executeInBackground(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    existingInvocationId?: string,
    contentBlocks?: readonly MessageContent[],
    sourceCategory?: ConnectorTriggerPolicy['sourceCategory'],
    suggestedSkill?: string,
    sender?: { id: string; name?: string },
    preAcquiredController?: AbortController,
    executionStartReceipt?: ExecutionStartReceipt,
  ): Promise<void> {
    const { router, socketManager, invocationRecordStore, invocationTracker, invocationQueue, log } = this.opts;
    const targetCats: CatId[] = [catId];
    let finalStatus: 'succeeded' | 'failed' | 'canceled' = 'failed';
    const terminalDispositions = new PerCatTerminalDispositionCollector({
      targetCatIds: targetCats,
      isCanceled: (completedCatId) => invocationTracker.getSlotState?.(threadId, completedCatId) === 'canceled',
    });

    // R1-P1 fix: move controller before try so finally always releases it (even if create() throws)
    const controller = preAcquiredController ?? invocationTracker.start(threadId, catId, userId, targetCats);

    const HEARTBEAT_INTERVAL_MS = 30_000;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    let invocationId: string | undefined;
    let executionStartRecorded = false;
    // R4 fix: hoist above try so catch can await it for correct failure cleanup
    // (onStreamEnd → cleanupPlaceholders, per messages.ts cleanupStreamingOnFailure).
    let streamStartPromise: Promise<void> | undefined;

    try {
      // ① InvocationRecord was created and atomically claimed by trigger() before
      // it reported `dispatched`. QueueProcessor owns the separate queued-admission path.
      if (!existingInvocationId) {
        throw new Error('Connector invocation reached execution without a durable invocation record');
      }
      const createResult = { outcome: 'created' as const, invocationId: existingInvocationId };

      invocationId = createResult.invocationId;
      invocationTracker.bindExecutionId?.(threadId, targetCats, controller, invocationId);

      if (controller?.signal.aborted) {
        if (controller.signal.reason === 'cancel_all') {
          // cancelAll may win after tracker reservation but before durable admission,
          // when it can only arm an ID-less slot fence. Bind the exact record identity
          // now so this terminal can consume that fence without making it wildcard.
          this.opts.queueProcessor?.bindAutoResumeSuppressionExecution(threadId, catId, invocationId);
        }
        finalStatus = 'canceled';
        await invocationRecordStore.update(invocationId, { status: 'canceled', expectedStatus: 'running' });
        executionStartReceipt?.reject(new Error('Connector invocation canceled before execution started'));
        log.warn(`[ConnectorInvokeTrigger] Thread ${threadId} is being deleted, skipping`);
        return;
      }

      heartbeatInterval = setInterval(() => {
        socketManager.broadcastToRoom(`thread:${threadId}`, 'heartbeat', { threadId, timestamp: Date.now() });
      }, HEARTBEAT_INTERVAL_MS);

      // #768: Defer intent_mode broadcast until CLI produces first event.
      let intentModeBroadcast = false;

      // ② Run routeExecution and broadcast each agent message
      const cursorBoundaries = new Map<string, string>();
      const persistenceContext: PersistenceContext = { failed: false, errors: [] };
      const collectedUsage = new Map<string, TokenUsage>();
      const collectedTextParts: string[] = [];

      // ISSUE-9: Track per-turn content for individual outbound delivery
      // Cloud-P1-4 fix: use ordered array (not Map) to preserve A→B→A turn boundaries
      const outboundTurns: Array<{
        catId: string;
        textParts: string[];
        richBlocks?: PersistenceContext['richBlocks'];
      }> = [];
      let currentTurnCatId: string | undefined;

      // Phase 4: Start streaming placeholder on external platforms
      // Fire-and-forget for the loop, but save the promise so onStreamEnd can await it
      // to prevent race (onStreamEnd before onStreamStart finishes registering sessions).
      if (this.opts.streamingHook) {
        streamStartPromise = this.opts.streamingHook
          .onStreamStart(threadId, catId, createResult.invocationId, sender)
          .catch((err) => {
            log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.onStreamStart failed');
          });
      }

      // F151: Deliver per-cat turns inside the loop to preserve ordering when
      // post_message callbacks from later cats interleave with earlier outboundTurns.
      const deliveredTurnIndices = new Set<number>();
      const DELIVER_TIMEOUT_MS = this.opts.deliverTimeoutMs ?? 10_000;

      // Start threadMeta lookup early — resolved lazily when first delivery needs it.
      let threadMeta: ThreadMeta | undefined;
      let threadMetaPromise: Promise<ThreadMeta | undefined> | undefined;
      if (this.opts.outboundHook && this.opts.threadMetaLookup) {
        const rawResult = this.opts.threadMetaLookup(threadId);
        if (rawResult) {
          const LOOKUP_TIMEOUT_MS = 2000;
          threadMetaPromise = Promise.race([
            Promise.resolve(rawResult).catch((err: unknown) => {
              log.warn({ err, threadId }, '[ConnectorInvokeTrigger] threadMetaLookup late rejection');
              return undefined;
            }),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS)),
          ]);
        }
      }

      // F140 Phase C: suggestedSkill flows via promptTags → SystemPromptBuilder (hint, not directive)
      const promptTags: string[] = suggestedSkill ? [`skill:${suggestedSkill}`] : [];
      const intent = { intent: 'execute' as const, explicit: false, promptTags };
      let turnCustodyWake: TurnCustodyWakeProvenance = {
        kind: 'legacy',
        reason: 'carrier_missing',
        ...(sourceCategory ? { sourceCategory } : {}),
      };
      if (this.opts.messageStore) {
        const durableInvocation = await invocationRecordStore.get(invocationId);
        if (!durableInvocation) {
          throw new Error(`Connector invocation ${invocationId} disappeared before wake provenance resolution`);
        }
        turnCustodyWake = await resolveQueueTurnCustodyWake(
          {
            threadId,
            messageId,
            source: 'connector',
            sourceCategory,
            targetCats,
            ...(durableInvocation.waitContinuationCarrier
              ? { waitContinuationCarrier: durableInvocation.waitContinuationCarrier }
              : {}),
          },
          this.opts.messageStore,
        );
      }

      let memoryCueOpportunitySeeds: MemoryCueOpportunitySeed[] = [];
      let asrPersonMemoryScenes: Awaited<ReturnType<typeof bindAsrPersonMemoryReentryFromSchedulerMessage>> = [];
      if (this.opts.messageStore) {
        try {
          memoryCueOpportunitySeeds = await readTrustedConnectorMemoryCueSeeds({
            entrySource: 'connector',
            messageId,
            expectedThreadId: threadId,
            expectedUserId: userId,
            messageStore: this.opts.messageStore,
          });
        } catch (err) {
          log.warn({ err, threadId, messageId }, '[F287] direct connector Cue carrier read failed closed');
        }
        try {
          const triggerMessage = await this.opts.messageStore.getById(messageId);
          if (triggerMessage) {
            asrPersonMemoryScenes = await bindAsrPersonMemoryReentryFromSchedulerMessage({
              triggerMessage,
              ownerUserId: userId,
              threadId,
              messageStore: this.opts.messageStore,
            });
          }
        } catch (err) {
          log.warn({ err, threadId, messageId }, '[F276] direct connector re-entry carrier read failed closed');
        }
      }

      for await (const msg of router.routeExecution(userId, message, threadId, messageId, targetCats, intent, {
        ownerAuthProvenance: 'unknown',
        humanDispositionInvocationOrigin: 'connector',
        turnCustodyWake,
        turnCustodyWakeForCat: (catId) => retargetTurnCustodyWake(turnCustodyWake, catId),
        ...(memoryCueOpportunitySeeds.length > 0 ? { memoryCueOpportunitySeeds } : {}),
        ...(asrPersonMemoryScenes.length > 0 ? { asrPersonMemoryScenes } : {}),
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(controller?.signal ? { signal: controller.signal } : {}),
        queueHasQueuedMessages: (tid: string) => invocationQueue.hasQueuedNonAgentForThread(tid),
        getQueuedFreshnessMessagesForCat: (tid: string, uid: string, catId: string, parentInvocationId?: string) =>
          invocationQueue.getQueuedFreshnessMessagesForCat(tid, uid, catId, { parentInvocationId }),
        deferA2AEnqueue: (e) => invocationQueue.enqueue({ ...e, ownerAuthProvenance: 'unknown' }),
        freshnessReinvokeEnqueue: (entry) => {
          const { freshnessContext: _freshnessContext, ...queueFields } = entry;
          return invocationQueue.enqueue({ ...queueFields, ownerAuthProvenance: 'unknown' });
        },
        hasQueuedOrActiveAgentForCat: (tid: string, catId: string) =>
          invocationQueue.hasActiveOrQueuedAgentForCat(tid, catId),
        hasPendingForCat: (tid: string, uid: string, catId: string) =>
          invocationQueue.hasPendingForCat(tid, catId, { userId: uid }),
        ...createA2ASlotTrackingBridge(invocationTracker, controller, createResult.invocationId),
        cursorBoundaries,
        persistenceContext,
        parentInvocationId: createResult.invocationId,
        onPromptMessagesExposed: (input) =>
          this.opts.queueProcessor?.markPromptMessagesSeen(input) ?? Promise.resolve(),
        // F222 P1: Connector-triggered execution is not user-origin — suppress frustration detection
        frustrationAutoIssueEligible: false,
        // #949 P2: Connector-sourced flows have no ball-pass expectation — suppress verdict warning
        verdictPassWarningEnabled: false,
      })) {
        const durableChildStart = parseDurableChildExecutionStart(msg, createResult.invocationId);
        if (!executionStartRecorded && durableChildStart) {
          // invokeSingleCat yields this exact child identity only after its
          // TurnExecutionStore.createRunning() succeeds. Pre-invocation router
          // events (degradation/context briefing) are deliberately ignored.
          await requireInvocationRecordUpdate({
            store: invocationRecordStore,
            invocationId: createResult.invocationId,
            update: {
              executionStartedAt: durableChildStart.startedAt,
              expectedStatus: 'running',
            },
            writer: 'connector execution-start receipt',
          });
          log.debug(
            {
              threadId,
              invocationId: createResult.invocationId,
              childInvocationId: durableChildStart.childInvocationId,
            },
            '[ConnectorInvokeTrigger] Durable child execution started',
          );
          executionStartRecorded = true;
          executionStartReceipt?.accept();
        }
        // #768: Broadcast intent_mode on first CLI event — proves CLI is alive.
        if (!intentModeBroadcast) {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
            threadId,
            mode: 'execute',
            targetCats,
            invocationId: createResult.invocationId,
          });
          intentModeBroadcast = true;
        }
        // F39 bugfix: stop broadcasting after cancel (drain pipe buffer silently)
        if (controller?.signal.aborted) break;
        terminalDispositions.observe(msg);
        if ((msg.type === 'done' || msg.type === 'error') && msg.catId) {
          invocationTracker.completeSlot?.(threadId, msg.catId, controller);
        }
        if (msg.type === 'done' && msg.catId) {
          if (msg.metadata?.usage) {
            collectedUsage.set(msg.catId, mergeTokenUsage(collectedUsage.get(msg.catId), msg.metadata.usage));
          }
          // ISSUE-9: snapshot richBlocks for current turn before next cat overwrites
          // Cloud-P1-5 fix: only reuse turn if still open (currentTurnCatId matches)
          if (persistenceContext.richBlocks) {
            const turn = outboundTurns[outboundTurns.length - 1];
            if (turn && turn.catId === msg.catId && currentTurnCatId === msg.catId) {
              turn.richBlocks = [...persistenceContext.richBlocks];
            } else {
              // Cat had richBlocks but no text — create a turn
              outboundTurns.push({ catId: msg.catId, textParts: [], richBlocks: [...persistenceContext.richBlocks] });
            }
            persistenceContext.richBlocks = undefined;
          }
          // Close current turn — next text message starts a new turn
          currentTurnCatId = undefined;
          // F151: Deliver completed cat's turns immediately to preserve ordering
          // when post_message callbacks from later cats fire during the loop.
          if (this.opts.outboundHook) {
            if (threadMetaPromise) {
              threadMeta = await threadMetaPromise;
              threadMetaPromise = undefined;
            }
            for (let i = 0; i < outboundTurns.length; i++) {
              if (deliveredTurnIndices.has(i)) continue;
              const turn = outboundTurns[i];
              if (turn.catId !== msg.catId) continue;
              if (!isConnectorDeliverable(persistenceContext.outputCommitDecisions?.[turn.catId])) continue;
              const turnContent = turn.textParts.join('');
              if (!turnContent && !turn.richBlocks?.length) continue;
              try {
                await Promise.race([
                  this.opts.outboundHook.deliver(
                    threadId,
                    turnContent,
                    turn.catId as CatId,
                    turn.richBlocks,
                    threadMeta,
                    undefined,
                    messageId,
                  ),
                  new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                  ),
                ]);
                deliveredTurnIndices.add(i);
              } catch (err) {
                log.error(
                  { err, threadId, catId: turn.catId },
                  '[ConnectorInvokeTrigger] Mid-loop delivery failed, will retry in final phase',
                );
              }
            }
          }
        }
        // Collect text content for outbound delivery (final-only)
        if (msg.type === 'text' && typeof msg.content === 'string') {
          collectedTextParts.push(msg.content);
          // ISSUE-9: per-turn text collection (new turn on catId change or after done)
          if (msg.catId) {
            if (msg.catId !== currentTurnCatId) {
              outboundTurns.push({ catId: msg.catId, textParts: [] });
              currentTurnCatId = msg.catId;
            }
            outboundTurns[outboundTurns.length - 1].textParts.push(msg.content);
          }
          // Phase 4: Stream accumulated text to external platforms
          if (this.opts.streamingHook) {
            const accumulated = collectedTextParts.join('');
            this.opts.streamingHook.onStreamChunk(threadId, accumulated, createResult.invocationId).catch((err) => {
              log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.onStreamChunk failed');
            });
          }
        }
        // F194 Phase Z9 (砚砚 R1 P1-2): unified visible turn stamp via helper.
        socketManager.broadcastAgentMessage(
          { ...msg, ...stampVisibleTurn(createResult.invocationId, msg.invocationId) },
          threadId,
        );
      }

      if (!executionStartRecorded) {
        throw new Error('Connector router ended before producing durable execution-start evidence');
      }

      // ③ Finalize: abort guard → persistence check → ack + succeeded
      // F39 P1 fix (砚砚 R1): abort guard after loop — same pattern as messages.ts.
      // When signal aborted and generator ends normally, break exits loop but
      // post-loop code would still run ack+succeeded without this guard.
      if (controller?.signal.aborted) {
        finalStatus = 'canceled';
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'canceled',
        });
        // Skip ack/succeeded — let finally handle cleanup
      } else if (persistenceContext.failed) {
        const errorDetail = persistenceContext.errors.map((e) => `${e.catId}: ${e.error}`).join('; ');
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'failed',
          error: `Connector invoke: message delivered but persistence failed: ${errorDetail}`,
        });
      } else {
        await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
        await requireInvocationRecordUpdate({
          store: invocationRecordStore,
          invocationId: createResult.invocationId,
          update: {
            status: 'succeeded',
            successfulCatIds: terminalDispositions.getSuccessfulCatIds() as CatId[],
            ...(collectedUsage.size > 0
              ? {
                  usageByCat: Object.fromEntries(collectedUsage),
                }
              : {}),
          },
          writer: 'connector invoke trigger',
        });
        finalStatus = 'succeeded';

        // ④ Outbound delivery: send final text + rich blocks to bound external chats
        const deliverableTurns = outboundTurns.filter((turn) =>
          isConnectorDeliverable(persistenceContext.outputCommitDecisions?.[turn.catId]),
        );
        const hasKnownUndeliverableOutput = Object.values(persistenceContext.outputCommitDecisions ?? {}).some(
          (decision) => !isConnectorDeliverable(decision),
        );
        const finalContent =
          outboundTurns.length > 0
            ? deliverableTurns.flatMap((turn) => turn.textParts).join('')
            : collectedTextParts.join('');

        // Phase 4: Finalize streaming — ensure start completed before ending
        if (this.opts.streamingHook) {
          if (streamStartPromise) {
            const STREAM_START_TIMEOUT_MS = 5000;
            await Promise.race([
              streamStartPromise,
              new Promise<void>((resolve) => setTimeout(resolve, STREAM_START_TIMEOUT_MS)),
            ]);
          }
          const outputDecisionEntries = Object.entries(persistenceContext.outputCommitDecisions ?? {});
          const supersededOutput = outputDecisionEntries.find(
            ([, decision]) => decision.kind === 'superseded_positive_stale',
          );
          const blockedOutput = outputDecisionEntries.find(([, decision]) => decision.kind === 'blocked_known_closure');
          if (blockedOutput?.[1].kind === 'blocked_known_closure' && this.opts.streamingHook.onClosureBlocked) {
            await this.opts.streamingHook
              .onClosureBlocked(threadId, blockedOutput[0] as CatId, blockedOutput[1].reason, createResult.invocationId)
              .catch((err) => log.warn({ err, threadId }, '[ConnectorInvokeTrigger] blocked projection failed'));
          } else if (
            supersededOutput?.[1].kind === 'superseded_positive_stale' &&
            this.opts.streamingHook.onClosureCatchingUp
          ) {
            await this.opts.streamingHook
              .onClosureCatchingUp(threadId, supersededOutput[0] as CatId, createResult.invocationId)
              .catch((err) => log.warn({ err, threadId }, '[ConnectorInvokeTrigger] catch projection failed'));
          } else {
            await this.opts.streamingHook
              .onStreamEnd(threadId, finalContent, createResult.invocationId)
              .catch((err) => {
                log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.onStreamEnd failed');
              });
          }
        }

        // R1-P1 fix: restore OR condition — richBlocks-only replies must also trigger delivery
        const hasContent = finalContent.length > 0 || deliverableTurns.some((turn) => turn.richBlocks?.length);
        log.info(
          {
            threadId,
            hasOutboundHook: !!this.opts.outboundHook,
            hasContent,
            textPartsCount: collectedTextParts.length,
            outboundTurnsCount: outboundTurns.length,
            finalContentLen: collectedTextParts.join('').length,
          },
          '[ConnectorInvokeTrigger] Outbound delivery check',
        );
        if (this.opts.outboundHook && hasContent) {
          // Resolve threadMeta if not yet done (no mid-loop delivery happened)
          if (threadMetaPromise) {
            threadMeta = await threadMetaPromise;
            threadMetaPromise = undefined;
          }

          // ISSUE-9 + Cloud-P1-4: deliver per-turn (ordered, supports A→B→A ping-pong)
          // F151: skip turns already delivered mid-loop
          const nonEmptyTurns = deliverableTurns.filter(
            (turn) =>
              !deliveredTurnIndices.has(outboundTurns.indexOf(turn)) &&
              (turn.textParts.length > 0 || (turn.richBlocks && turn.richBlocks.length > 0)),
          );

          let deliveryFailed = false;
          // Cloud-R4-P2: keep references to in-flight deliver promises so we can
          // schedule late-success cleanup when a delivery times out but later succeeds.
          const inflightDeliverPromises: Promise<void>[] = [];

          // BUG-5 (2026-03-25): iLink context_token is reusable — SINGLE_TOKEN_CONNECTORS
          // merge logic removed. Each turn now delivers independently for all connectors.
          if (nonEmptyTurns.length > 1) {
            for (const turn of nonEmptyTurns) {
              const turnContent = turn.textParts.join('');
              const deliverPromise = this.opts.outboundHook.deliver(
                threadId,
                turnContent,
                turn.catId as CatId,
                turn.richBlocks,
                threadMeta,
                undefined,
                messageId,
              );
              inflightDeliverPromises.push(deliverPromise);
              try {
                await Promise.race([
                  deliverPromise,
                  new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                  ),
                ]);
              } catch (err) {
                deliveryFailed = true;
                log.error({ err, threadId, catId: turn.catId }, '[ConnectorInvokeTrigger] Outbound delivery error');
              }
            }
          } else if (nonEmptyTurns.length === 1) {
            const turn = nonEmptyTurns[0];
            const richBlocks = persistenceContext.richBlocks ?? turn.richBlocks;
            const deliverPromise = this.opts.outboundHook.deliver(
              threadId,
              finalContent,
              turn.catId as CatId,
              richBlocks,
              threadMeta,
              undefined,
              messageId,
            );
            inflightDeliverPromises.push(deliverPromise);
            try {
              await Promise.race([
                deliverPromise,
                new Promise<void>((_, reject) =>
                  setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                ),
              ]);
            } catch (err) {
              deliveryFailed = true;
              log.error({ err, threadId }, '[ConnectorInvokeTrigger] Outbound delivery error');
            }
          } else if (deliveredTurnIndices.size === 0) {
            // Fallback: no per-turn delivery happened — deliver all content as one
            const richBlocks = persistenceContext.richBlocks;
            const deliverPromise = this.opts.outboundHook.deliver(
              threadId,
              finalContent,
              catId,
              richBlocks,
              threadMeta,
              undefined,
              messageId,
            );
            inflightDeliverPromises.push(deliverPromise);
            try {
              await Promise.race([
                deliverPromise,
                new Promise<void>((_, reject) =>
                  setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                ),
              ]);
            } catch (err) {
              deliveryFailed = true;
              log.error({ err, threadId }, '[ConnectorInvokeTrigger] Outbound delivery error');
            }
          }

          // Cloud-P1-R2: only cleanup placeholders if ALL deliveries succeeded
          if (!deliveryFailed && this.opts.streamingHook?.cleanupPlaceholders) {
            await this.opts.streamingHook.cleanupPlaceholders(threadId, createResult.invocationId).catch((err) => {
              log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.cleanupPlaceholders failed');
            });
          } else if (deliveryFailed && this.opts.streamingHook?.cleanupPlaceholders) {
            const cleanupHook = this.opts.streamingHook;
            const scopedInvocationId = createResult.invocationId;
            Promise.allSettled(inflightDeliverPromises).then((results) => {
              if (results.every((r) => r.status === 'fulfilled')) {
                cleanupHook.cleanupPlaceholders(threadId, scopedInvocationId).catch((err) => {
                  log.warn(
                    { err, threadId },
                    '[ConnectorInvokeTrigger] Placeholder cleanup failed after late-success delivery',
                  );
                });
              }
            });
          }
        } else if (!hasKnownUndeliverableOutput) {
          // R6+R7 fix: deliver fallback FIRST (with timeout), then cleanup placeholder
          // only on success — preserves "thinking" card if delivery fails (Cloud P2).
          // Timeout prevents adapter hang from blocking finally (Cloud P1).
          // R7: late-success cleanup mirrors normal content-delivery pattern (lines 641-653).
          let silentDeliveryOk = !this.opts.outboundHook; // no hook → proceed to cleanup
          let silentDeliverPromise: Promise<void> | undefined;
          if (this.opts.outboundHook) {
            silentDeliverPromise = this.opts.outboundHook.deliver(
              threadId,
              '处理完成，但未产生回复内容。',
              catId,
              undefined,
              undefined,
              undefined,
              messageId,
            );
            try {
              await Promise.race([
                silentDeliverPromise,
                new Promise<void>((_, reject) =>
                  setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                ),
              ]);
              silentDeliveryOk = true;
            } catch (deliverErr) {
              log.error({ err: deliverErr, threadId }, '[ConnectorInvokeTrigger] Silent-path outbound delivery failed');
            }
          }
          if (silentDeliveryOk && this.opts.streamingHook?.cleanupPlaceholders) {
            await this.opts.streamingHook.cleanupPlaceholders(threadId, createResult.invocationId).catch((err) => {
              log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.cleanupPlaceholders failed (silent)');
            });
          } else if (silentDeliverPromise && this.opts.streamingHook?.cleanupPlaceholders) {
            // R7: timeout fired but delivery may still succeed — defer cleanup to late-success
            const cleanupHook = this.opts.streamingHook;
            const scopedInvocationId = createResult.invocationId;
            silentDeliverPromise
              .then(() => {
                cleanupHook.cleanupPlaceholders(threadId, scopedInvocationId).catch((err) => {
                  log.warn(
                    { err, threadId },
                    '[ConnectorInvokeTrigger] Silent late-success placeholder cleanup failed',
                  );
                });
              })
              .catch(() => {
                /* delivery truly failed — thinking card stays as fallback UX */
              });
          }
        }
      }

      log.info(
        `[ConnectorInvokeTrigger] Invocation ${createResult.invocationId} completed for ${catId} in thread ${threadId}`,
      );
    } catch (err) {
      executionStartReceipt?.reject(err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`[ConnectorInvokeTrigger] Invocation failed: ${errorMsg}`);

      // Best-effort status update — don't let this throw mask the original error
      if (invocationId) {
        try {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: errorMsg,
          });
        } catch (statusErr) {
          log.warn(
            { err: statusErr, invocationId },
            '[ConnectorInvokeTrigger] invocation status update failed (best-effort)',
          );
        }
      }

      socketManager.broadcastAgentMessage(
        {
          type: 'error',
          catId: getDefaultCatId(),
          error: `Connector invoke failed: ${errorMsg}`,
          isFinal: true,
          timestamp: Date.now(),
        },
        threadId,
      );

      // R4 fix (#873): correct failure cleanup — onStreamEnd transitions sessions
      // from active → pendingCleanup; cleanupPlaceholders alone is a no-op on active
      // sessions. Matches messages.ts cleanupStreamingOnFailure() sequence.
      if (this.opts.streamingHook) {
        try {
          const STREAM_START_TIMEOUT_MS = 5000;
          if (streamStartPromise) {
            await Promise.race([streamStartPromise, new Promise<void>((r) => setTimeout(r, STREAM_START_TIMEOUT_MS))]);
          }
          await this.opts.streamingHook.onStreamEnd(threadId, '', invocationId);
          await this.opts.streamingHook.cleanupPlaceholders?.(threadId, invocationId);
        } catch (cleanupErr) {
          log.warn({ err: cleanupErr, threadId }, '[ConnectorInvokeTrigger] Error-path streaming cleanup failed');
        }
      }

      // #873: Deliver error message to external IM platform so user sees a reply (not silence)
      // R6 fix: timeout prevents adapter hang from blocking finally (Cloud P1).
      if (this.opts.outboundHook) {
        const ERROR_DELIVER_TIMEOUT_MS = this.opts.deliverTimeoutMs ?? 10_000;
        try {
          await Promise.race([
            this.opts.outboundHook.deliver(
              threadId,
              '抱歉，处理消息时遇到问题，请稍后重试。',
              catId,
              undefined,
              undefined,
              undefined,
              messageId,
            ),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('deliver timeout')), ERROR_DELIVER_TIMEOUT_MS),
            ),
          ]);
        } catch (deliverErr) {
          log.error({ err: deliverErr, threadId }, '[ConnectorInvokeTrigger] Error-path outbound delivery failed');
        }
      }
    } finally {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      invocationTracker.complete(threadId, catId, controller);
      // F39 P1 fix: Notify queue processor for auto-dequeue chain
      this.opts.queueProcessor
        ?.onInvocationComplete(
          threadId,
          catId,
          finalStatus,
          invocationId,
          finalStatus === 'succeeded' ? terminalDispositions.getSuccessfulCatIds() : [],
        )
        .catch(() => {
          /* best-effort, don't crash background task */
        });
      // F151: Signal adapters that this invocation's delivery batch is complete.
      // Fires on both success AND failure — failed invocations must close the task
      // immediately instead of waiting for TASK_TIMEOUT_MS (P2-1 review fix).
      if (this.opts.streamingHook?.notifyDeliveryBatchDone) {
        const threadStillBusy =
          invocationTracker.has(threadId) || (this.opts.queueProcessor?.isThreadBusy(threadId) ?? false);
        this.opts.streamingHook.notifyDeliveryBatchDone(threadId, !threadStillBusy).catch((err) => {
          log.warn({ err, threadId }, '[ConnectorInvokeTrigger] notifyDeliveryBatchDone failed');
        });
      }
    }
  }
}
