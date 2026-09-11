/**
 * InvocationQueue
 * Per-thread durable work ledger for user/connector/agent/system dispatch.
 *
 * 与 InvocationTracker（互斥锁，跟踪活跃调用）互补：
 * - InvocationTracker: "谁在跑"
 * - InvocationQueue: "谁在等"
 *
 * The in-memory maps below are a process-local projection only. QueueLedgerStore
 * owns canonical persistence and recovery; every mutation crosses that boundary
 * before the cache is updated.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  CatRoutingError,
  MessageFrom,
  QueueAuthorIntent,
  QueueAuthorIntentFallbackReason,
  QueueReminderAttempt,
  QueueTargetAttemptTerminalReason,
  WaitContinuationCarrierV1,
} from '@cat-cafe/shared';
import { isMessageFrom } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  type ActionSuccessorFence,
  actionSuccessorFencesMatch,
} from '../../../../ball-custody/ActionSuccessorAdmissionContract.js';
import type { CloudDispatchProvenance } from '../../cloud-bridge/types.js';
import type {
  AppendMessageInput,
  IMessageStore,
  LifecycleResponseTerminalPatch,
  StoredMessage,
} from '../../stores/ports/MessageStore.js';
import type { ToolExecutionPolicy } from '../../types.js';
import { compareLifecycleQueueEntries } from './message-lifecycle-queue-order.js';
import type { OwnerAuthProvenance } from './owner-auth-provenance.js';
import { InMemoryQueueLedgerStore } from './queue-ledger/InMemoryQueueLedgerStore.js';
import {
  type QueueLedgerEntry,
  type QueueLedgerStore,
  type QueueOwner,
  queueEntryId,
  queueOwner,
} from './queue-ledger/QueueLedger.js';
import { createQueueLedgerAdmission } from './queue-ledger/QueueLedgerAdmission.js';

export type QueueEntry = QueueLedgerEntry;

type QueueAttemptSettlementOutcome = 'handled' | 'failed' | 'interrupted' | 'cancelled';

interface AdmittedAttemptEvidence {
  awakenedInvocationId?: string;
  awakenedAt?: number;
  seenInvocationId?: string;
  seenAt?: number;
}

export interface QueueEnqueueInput {
  threadId: string;
  userId: string;
  owner?: QueueOwner;
  sourceId?: string;
  kind: QueueLedgerEntry['kind'];
  ownerAuthProvenance: OwnerAuthProvenance;
  idempotencyKey?: string;
  content: string;
  messageId?: string | null;
  from: MessageFrom;
  targetCats: string[];
  routingWarnings?: CatRoutingError[];
  authorIntentByCatId?: Record<string, QueueAuthorIntent>;
  intent: string;
  autoExecute?: boolean;
  priority?: QueueLedgerEntry['priority'];
  sourceCategory?: QueueLedgerEntry['sourceCategory'];
  continuationKey?: string;
  a2aParentInvocationId?: string;
  freshnessClosureId?: string;
  freshnessSupplementId?: string;
  freshnessSupplementLineageId?: string;
  freshnessSupplementSeq?: 1 | 2;
  readOnlyToolPolicy?: ToolExecutionPolicy;
  actionSuccessorFence?: ActionSuccessorFence;
  waitContinuationCarrier?: WaitContinuationCarrierV1;
  position?: number;
  suggestedSkill?: string;
  callerTraceContext?: CallerTraceContext;
  a2aTriggerMessageId?: string;
  cloudDispatchProvenance?: CloudDispatchProvenance;
  requiresExactCloudDispatchProvenance?: boolean;
  dedupeProcessing?: boolean;
}

export function exactA2ASourceMessageIds(entry: Pick<QueueEntry, 'execution' | 'payload'>): string[] {
  return [
    ...new Set(
      [entry.execution.a2aTriggerMessageId, entry.payload.messageId].filter(
        (messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0,
      ),
    ),
  ];
}

export interface EnqueueResult {
  outcome: 'enqueued' | 'full';
  entry?: QueueEntry;
  queuePosition?: number;
  /** True when enqueue returned an existing active entry by idempotency key. */
  deduped?: boolean;
}

export type EnqueueMessageResult =
  | { outcome: 'full' }
  | {
      outcome: 'enqueued';
      message: StoredMessage;
      entry?: QueueEntry;
      entries: QueueEntry[];
      queuePosition?: number;
      deduped: boolean;
    };

export type DurableSteerClaimResult =
  | { outcome: 'claimed'; entries: QueueEntry[]; targetCatId: string }
  | {
      outcome: 'rejected';
      reason: 'entry_not_found' | 'entry_processing' | 'entry_ineligible';
    };

export type DurableMessageClaimResult =
  | { outcome: 'claimed'; entries: QueueEntry[] }
  | { outcome: 'not_found' | 'processing' };

export interface ActionSuccessorQueueRetirement {
  entryId: string;
  threadId: string;
  userId: string;
  messageIds: string[];
}

const MAX_QUEUE_DEPTH = 5;

/**
 * Stable InvocationRecord identity for an ActionSuccessor carrier.
 *
 * Queue row ids are derived from a durable producer identity. ActionSuccessor
 * supplies the lease/generation identity so retries converge on the same row.
 */
export function actionSuccessorInvocationIdempotencyKey(queueIdempotencyKey: string): string {
  return `action-successor:${queueIdempotencyKey}`;
}

export function queueEntrySource(entry: Pick<QueueEntry, 'from'>): 'user' | 'connector' | 'agent' | 'system' {
  if (entry.from.kind === 'user') return 'user';
  if (entry.from.kind === 'agent') return 'agent';
  if (entry.from.kind === 'system') return 'system';
  return 'connector';
}

export function queueEntryCallerCatId(entry: Pick<QueueEntry, 'from'>): string | undefined {
  return entry.from.kind === 'agent' ? entry.from.catId : undefined;
}

export function queueEntrySenderMeta(
  entry: Pick<QueueEntry, 'from'>,
): { readonly id: string; readonly name?: string } | undefined {
  return entry.from.kind === 'external' ? entry.from.sender : undefined;
}

export function queueEntryTargetCats(entry: Pick<QueueEntry, 'targets'>): string[] {
  return [...entry.targets];
}

export function queueEntryOwnerId(entry: Pick<QueueEntry, 'owner'>): string {
  return entry.owner.kind === 'user' ? entry.owner.userId : `system:${entry.owner.service}`;
}

export function queueEntryMessageIds(entry: Pick<QueueEntry, 'payload'>): string[] {
  return entry.payload.messageId ? [entry.payload.messageId] : [];
}

export function isSystemPinnedQueueEntry(entry: Pick<QueueEntry, 'from' | 'sourceCategory'>): boolean {
  return entry.from.kind === 'agent' && entry.sourceCategory === 'continuation';
}

/**
 * Ordinary Queue target-selection paths must never reopen a target whose latest
 * attempt is terminal-failed. The entry itself may still carry eligible siblings
 * or remain visible to lifecycle/recovery code.
 */
export function isOrdinaryQueueTargetEligible(entry: Pick<QueueEntry, 'status' | 'targets'>, catId: string): boolean {
  return (
    (entry.status === 'queued' || entry.status === 'claimed') &&
    (entry.targets.length === 0 || entry.targets.includes(catId))
  );
}

function isQueueTargetPending(entry: Pick<QueueEntry, 'status' | 'targets'>, catId: string): boolean {
  return entry.status !== 'terminal' && entry.targets.includes(catId);
}

export class InvocationQueue {
  static readonly STALE_PROCESSING_THRESHOLD_MS = 600_000;

  private readonly log = createModuleLogger('invocation-queue');
  private queues = new Map<string, QueueEntry[]>();
  /**
   * Process-local handoff snapshots after Queue has removed the dispatched
   * target. These are not Queue truth and are never hydrated or persisted;
   * ActiveRun + History own execution and terminal lifecycle.
   */
  private readonly admittedEntries = new Map<string, QueueEntry[]>();
  /** Runtime-only prompt evidence keyed by admitted snapshots. It is never serialized into Queue rows. */
  private readonly admittedAttemptEvidence = new WeakMap<QueueEntry, AdmittedAttemptEvidence>();
  private lastEnqueuedAt = 0;
  /** Claimed rows remain reversible until tracker admission owns execution. */
  private readonly ledgerClaimIds = new Map<string, string>();

  constructor(private readonly ledgerStore: QueueLedgerStore = new InMemoryQueueLedgerStore()) {}

  private scopeKey(threadId: string, userId: string): string {
    return `${threadId}:${userId}`;
  }

  private queueMatchesThread(q: QueueEntry[], threadId: string): boolean {
    return q.some((entry) => entry.threadId === threadId);
  }

  private getOrCreate(key: string): QueueEntry[] {
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    return q;
  }

  private static persistentSourceId(input: QueueEnqueueInput): string {
    const sourceId =
      input.sourceId ??
      input.messageId ??
      input.idempotencyKey ??
      input.continuationKey ??
      input.freshnessSupplementId ??
      input.freshnessClosureId;
    if (!sourceId) throw new Error('durable Queue admission requires a persistent producer identity');
    return sourceId;
  }

  /** Enforce the canonical Queue admission contract on both live and restart paths. */
  private static requireAdmissionContract(input: {
    kind: unknown;
    from: unknown;
    userId?: unknown;
    targetCats: unknown;
    messageId?: unknown;
    a2aTriggerMessageId?: unknown;
    ownerAuthProvenance: unknown;
  }): { kind: QueueEntry['kind']; ownerAuthProvenance: OwnerAuthProvenance } {
    const kind = input.kind;
    if (kind !== 'conversation_input' && kind !== 'message_wake' && kind !== 'private_input') {
      throw new Error('kind must be explicit on every Queue producer');
    }
    if (
      !Array.isArray(input.targetCats) ||
      input.targetCats.some((catId) => typeof catId !== 'string' || catId.length === 0) ||
      new Set(input.targetCats).size !== input.targetCats.length
    ) {
      throw new Error('targetCats must contain unique non-empty target ids');
    }
    if (kind !== 'conversation_input' && input.targetCats.length === 0) {
      throw new Error(`${kind} must have an exact target`);
    }
    if (!isMessageFrom(input.from)) {
      throw new Error('from must be explicit on every Queue producer');
    }
    if (input.from.kind === 'user' && input.from.userId !== input.userId) {
      throw new Error('Queue user sender must match the owner userId');
    }
    if (kind === 'private_input' && input.messageId != null) {
      throw new Error('private_input cannot reference a public History message');
    }
    if (kind === 'message_wake' && !input.messageId && !input.a2aTriggerMessageId) {
      throw new Error('message_wake must reference an existing History message');
    }
    const ownerAuthProvenance = input.ownerAuthProvenance;
    if (
      ownerAuthProvenance !== 'strict' &&
      ownerAuthProvenance !== 'compatibility_fallback' &&
      ownerAuthProvenance !== 'unknown'
    ) {
      throw new Error('ownerAuthProvenance must be explicit on every Queue producer');
    }
    return { kind, ownerAuthProvenance };
  }

  private nextEnqueuedAt(): number {
    const now = Date.now();
    this.lastEnqueuedAt = Math.max(now, this.lastEnqueuedAt + 1);
    return this.lastEnqueuedAt;
  }

  /** RFC #1356's only Queue comparator: position → priority → FIFO → stable id. */
  private static compareEntries(a: QueueEntry, b: QueueEntry): number {
    return compareLifecycleQueueEntries(
      { id: a.id, priority: a.priority, enqueuedAt: a.enqueuedAt, position: a.position },
      { id: b.id, priority: b.priority, enqueuedAt: b.enqueuedAt, position: b.position },
    );
  }

  private createLedgerRows(
    input: QueueEnqueueInput,
    sourceId: string,
    enqueuedAt: number,
    messageId?: string,
  ): QueueLedgerEntry[] {
    InvocationQueue.requireAdmissionContract({ ...input, messageId: messageId ?? input.messageId });
    return createQueueLedgerAdmission({
      sourceId,
      threadId: input.threadId,
      owner: queueOwner(input),
      kind: input.kind,
      from: input.from,
      targetCatIds: input.targetCats,
      content: input.content,
      ...(messageId ? { messageId } : {}),
      ...(input.routingWarnings ? { routingWarnings: input.routingWarnings } : {}),
      ...(input.authorIntentByCatId ? { authorIntentByCatId: input.authorIntentByCatId } : {}),
      intent: input.intent,
      ownerAuthProvenance: input.ownerAuthProvenance,
      autoExecute: input.autoExecute,
      priority: input.priority,
      sourceCategory: input.sourceCategory,
      a2aParentInvocationId: input.a2aParentInvocationId,
      freshnessClosureId: input.freshnessClosureId,
      freshnessSupplementId: input.freshnessSupplementId,
      freshnessSupplementLineageId: input.freshnessSupplementLineageId,
      freshnessSupplementSeq: input.freshnessSupplementSeq,
      readOnlyToolPolicy: input.readOnlyToolPolicy,
      actionSuccessorFence: input.actionSuccessorFence,
      waitContinuationCarrier: input.waitContinuationCarrier,
      suggestedSkill: input.suggestedSkill,
      callerTraceContext: input.callerTraceContext,
      a2aTriggerMessageId: input.a2aTriggerMessageId ?? (input.kind === 'message_wake' ? messageId : undefined),
      cloudDispatchProvenance: input.cloudDispatchProvenance,
      requiresExactCloudDispatchProvenance: input.requiresExactCloudDispatchProvenance,
      enqueuedAt,
    });
  }

  private static projectLedgerEntry(entry: QueueLedgerEntry): QueueEntry {
    return structuredClone(entry);
  }

  private cacheLedgerEntries(entries: readonly QueueLedgerEntry[]): QueueEntry[] {
    const projected: QueueEntry[] = [];
    for (const row of entries) {
      if (row.status === 'terminal') {
        this.removeCachedEntry(row.threadId, row.id);
        continue;
      }
      const entry = InvocationQueue.projectLedgerEntry(row);
      const queue = this.getOrCreate(this.scopeKey(entry.threadId, queueEntryOwnerId(entry)));
      const index = queue.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) queue[index] = entry;
      else queue.push(entry);
      projected.push(structuredClone(entry));
    }
    return projected;
  }

  async hydrateFromLedger(messageStore?: Pick<IMessageStore, 'getById'>): Promise<number> {
    this.queues.clear();
    this.admittedEntries.clear();
    this.ledgerClaimIds.clear();
    let count = 0;
    for (const threadId of await this.ledgerStore.listThreadIds()) {
      const rows: QueueLedgerEntry[] = [];
      for (const row of await this.ledgerStore.list(threadId)) {
        if (row.status !== 'claimed' || !row.claimId) {
          rows.push(row);
          continue;
        }
        const source = row.payload.messageId ? await messageStore?.getById(row.payload.messageId) : null;
        if (source?.recall || (source?.deliveryStatus && source.deliveryStatus !== 'queued')) {
          const terminal = await this.ledgerStore.commit(threadId, row.id, row.claimId, 'withdrawn', Date.now());
          if (terminal.outcome === 'updated') rows.push(terminal.entry);
          continue;
        }
        const restored = await this.ledgerStore.restore(
          threadId,
          row.id,
          row.claimId,
          row.id === queueEntryId(row.payload.sourceRecordId),
        );
        if (restored.outcome === 'updated') rows.push(restored.entry);
      }
      count += this.cacheLedgerEntries(rows).length;
    }
    return count;
  }

  async enqueueDurable(input: QueueEnqueueInput): Promise<EnqueueResult & { entries?: QueueEntry[] }> {
    const sourceId = InvocationQueue.persistentSourceId(input);
    const enqueuedAt = this.nextEnqueuedAt();
    const rows = this.createLedgerRows(input, sourceId, enqueuedAt, input.messageId ?? undefined);
    const result = await this.ledgerStore.enqueue(rows, input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined);
    if (result.outcome === 'full') return { outcome: 'full' };
    if (result.outcome === 'conflict') throw new Error(`Queue admission identity conflict: ${sourceId}`);
    const entries = this.cacheLedgerEntries(result.entries);
    const primary = entries[0];
    return {
      outcome: 'enqueued',
      ...(primary ? { entry: primary } : {}),
      entries,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.outcome === 'replayed',
    };
  }

  /** Synchronous durable admission for the in-memory store used by local/test hosts. */
  enqueueDurableNow(input: QueueEnqueueInput): EnqueueResult & { entries?: QueueEntry[] } {
    if (!(this.ledgerStore instanceof InMemoryQueueLedgerStore)) {
      throw new Error('synchronous durable Queue admission requires the in-memory ledger');
    }
    const sourceId = InvocationQueue.persistentSourceId(input);
    const rows = this.createLedgerRows(input, sourceId, this.nextEnqueuedAt(), input.messageId ?? undefined);
    const result = this.ledgerStore.enqueueNow(rows, input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined);
    if (result.outcome === 'full') return { outcome: 'full' };
    if (result.outcome === 'conflict') throw new Error(`Queue admission identity conflict: ${sourceId}`);
    const entries = this.cacheLedgerEntries(result.entries);
    const primary = entries[0];
    return {
      outcome: 'enqueued',
      ...(primary ? { entry: primary } : {}),
      entries,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.outcome === 'replayed',
    };
  }

  /** One storage transaction for a queued Message and its complete Queue fan-out. */
  async appendAndEnqueueDurable(
    messageStore: IMessageStore,
    message: AppendMessageInput,
    input: QueueEnqueueInput,
  ): Promise<EnqueueMessageResult> {
    if (
      (message.threadId ?? 'default') !== input.threadId ||
      message.userId !== input.userId ||
      message.content !== input.content ||
      JSON.stringify(message.from) !== JSON.stringify(input.from) ||
      (message.deliveryStatus !== 'queued' && !(message.from.kind === 'agent' && message.deliveryStatus === undefined))
    ) {
      throw new Error('atomic Queue admission message does not match its execution work item');
    }
    const enqueuedAt = this.nextEnqueuedAt();
    const result = await messageStore.appendWithQueueLedgerAdmission(
      message,
      (messageId) => this.createLedgerRows(input, messageId, enqueuedAt, messageId),
      this.ledgerStore,
      input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined,
    );
    if (result.outcome === 'full') return { outcome: 'full' };

    const projected = this.cacheLedgerEntries(result.entries);
    const expected = this.createLedgerRows(input, result.message.id, enqueuedAt, result.message.id);
    const primary =
      projected[0] ??
      (() => {
        const first = expected[0];
        if (!first) return undefined;
        const owner = queueOwner(input);
        const ownerUserId = owner.kind === 'user' ? owner.userId : `system:${owner.service}`;
        return this.findEntry(input.threadId, ownerUserId, first.id);
      })();
    return {
      outcome: 'enqueued',
      message: result.message,
      ...(primary ? { entry: { ...primary } } : {}),
      entries: projected,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.deduped,
    };
  }

  /** One storage transaction for a terminal response bubble and its outbound A2A fan-out. */
  async terminalizeResponseAndEnqueueDurable(
    messageStore: IMessageStore,
    responseMessageId: string,
    terminalPatch: LifecycleResponseTerminalPatch,
    input: QueueEnqueueInput,
  ): Promise<EnqueueMessageResult> {
    const source = await messageStore.getById(responseMessageId);
    if (
      !source ||
      source.threadId !== input.threadId ||
      source.userId !== input.userId ||
      source.content === undefined ||
      JSON.stringify(source.from) !== JSON.stringify(input.from)
    ) {
      throw new Error('lifecycle Queue source does not match its execution work item');
    }
    const canonicalInput: QueueEnqueueInput = {
      ...input,
      sourceId: responseMessageId,
      messageId: responseMessageId,
    };
    const rows = this.createLedgerRows(canonicalInput, responseMessageId, source.timestamp, responseMessageId);
    const result = await messageStore.commitLifecycleResponseTerminalWithQueueLedgerAdmission(
      responseMessageId,
      terminalPatch,
      rows,
      this.ledgerStore,
      input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined,
    );
    if (result.kind === 'full') return { outcome: 'full' };
    if (result.kind !== 'applied' && result.kind !== 'replayed') {
      throw new Error(
        `lifecycle response terminal Queue admission conflict: ${result.kind}:${'reason' in result ? result.reason : 'missing'}`,
      );
    }
    const projected = this.cacheLedgerEntries(result.entries);
    const primary = projected[0];
    return {
      outcome: 'enqueued',
      message: result.message,
      ...(primary ? { entry: primary } : {}),
      entries: projected,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.ledgerReplayed,
    };
  }

  /** Atomically adopt one already-persisted connector message into the ledger. */
  async enqueueExistingMessageDurable(
    messageStore: IMessageStore,
    messageId: string,
    input: QueueEnqueueInput,
  ): Promise<EnqueueMessageResult> {
    const source = await messageStore.getById(messageId);
    if (
      !source ||
      source.threadId !== input.threadId ||
      source.userId !== input.userId ||
      source.content !== input.content ||
      JSON.stringify(source.from) !== JSON.stringify(input.from)
    ) {
      throw new Error('existing Queue source does not match its execution work item');
    }
    const enqueuedAt = this.nextEnqueuedAt();
    const rows = this.createLedgerRows(input, messageId, enqueuedAt, messageId);
    const result = await messageStore.enqueueExistingMessageWithQueueLedgerAdmission(
      messageId,
      rows,
      this.ledgerStore,
      input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined,
    );
    if (result.outcome === 'full') return { outcome: 'full' };
    const projected = this.cacheLedgerEntries(result.entries);
    const primary = projected[0];
    return {
      outcome: 'enqueued',
      message: result.message,
      ...(primary ? { entry: primary } : {}),
      entries: projected,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.deduped,
    };
  }

  /**
   * Atomically verify the selected source entry, bind an optional
   * targetless anchor, and add missing siblings. A terminal race therefore
   * rejects the whole Steer mapping instead of leaving a partial fan-out.
   */
  async mapQueuedMessageTargetsDurable(
    messageStore: Pick<IMessageStore, 'getById'>,
    messageId: string,
    entryId: string,
    bindTargetCatId: string,
    expectedQueuedEntryIds: readonly string[],
    input: QueueEnqueueInput,
  ) {
    const source = await messageStore.getById(messageId);
    if (
      !source ||
      source.threadId !== input.threadId ||
      source.userId !== input.userId ||
      source.content !== input.content ||
      JSON.stringify(source.from) !== JSON.stringify(input.from) ||
      (source.deliveryStatus !== 'queued' && source.deliveryStatus !== 'delivered')
    ) {
      throw new Error('queued Message does not match its target fan-out expansion');
    }
    const anchor = await this.ledgerStore.get(input.threadId, entryId);
    if (!anchor) return { outcome: 'not_found' as const, entries: [] };
    const siblingInput: QueueEnqueueInput = { ...input, sourceId: messageId, messageId };
    const siblingRows =
      siblingInput.targetCats.length > 0
        ? this.createLedgerRows(siblingInput, messageId, anchor.enqueuedAt, messageId).map((row) => ({
            ...row,
            ...(anchor.position !== undefined ? { position: anchor.position } : {}),
          }))
        : [];
    const result = await this.ledgerStore.expandTargets(
      input.threadId,
      entryId,
      bindTargetCatId,
      expectedQueuedEntryIds,
      siblingRows,
    );
    if (result.outcome === 'expanded' || result.outcome === 'replayed') {
      return { ...result, entries: this.cacheLedgerEntries(result.entries) };
    }
    return result;
  }

  /**
   * Apply the user's explicit Steer delta to the current pending target set.
   * Targets delivered while the modal was open are absent from Queue already;
   * this method therefore never reconstructs them from a stale browser list.
   */
  async reconcileQueuedMessageTargetsDurable(
    threadId: string,
    userId: string,
    entryId: string,
    addTargetIds: readonly string[],
    removeTargetIds: readonly string[],
    authorIntentByTarget: Readonly<Record<string, QueueAuthorIntent>>,
  ) {
    const current = await this.ledgerStore.get(threadId, entryId);
    if (current && queueEntryOwnerId(current) !== userId) {
      throw new Error('Queue target reconciliation owner mismatch');
    }
    const result = await this.ledgerStore.reconcileTargets(
      threadId,
      entryId,
      addTargetIds,
      removeTargetIds,
      authorIntentByTarget,
    );
    if (result.outcome === 'updated' || result.outcome === 'replayed') {
      this.removeCachedEntry(threadId, entryId);
      if (result.entry) this.cacheLedgerEntries([result.entry]);
    }
    return result;
  }

  private findEntryAcrossUsers(threadId: string, entryId: string): QueueEntry | undefined {
    for (const queue of this.queues.values()) {
      if (!this.queueMatchesThread(queue, threadId)) continue;
      const entry = queue.find((candidate) => candidate.id === entryId);
      if (entry) return entry;
    }
    return undefined;
  }

  private async claimLedgerEntry(entry: QueueEntry, selectedTargetCatId?: string): Promise<QueueEntry | null> {
    const claimId = randomUUID();
    const claimedAt = Date.now();
    // The selected target has two jobs in the store: bind a targetless row on
    // first dispatch, or claim only that target from an existing target set.
    // Omitting it for targeted rows accidentally claimed every sibling.
    const claimed = await this.ledgerStore.claim(entry.threadId, entry.id, claimId, claimedAt, selectedTargetCatId);
    if (claimed.outcome !== 'claimed') return null;
    const [projected] = this.cacheLedgerEntries(claimed.entries);
    if (!projected) return null;
    this.ledgerClaimIds.set(projected.id, claimId);
    return structuredClone(projected);
  }

  private rememberAdmittedEntry(entry: QueueEntry): void {
    const entries = this.admittedEntries.get(entry.id) ?? [];
    const admitted = structuredClone(entry);
    entries.push(admitted);
    this.admittedAttemptEvidence.set(admitted, {});
    this.admittedEntries.set(entry.id, entries);
  }

  private findAdmittedEntry(
    threadId: string,
    entryId: string,
    targetCatId?: string,
    userId?: string,
  ): QueueEntry | undefined {
    return this.admittedEntries
      .get(entryId)
      ?.find(
        (entry) =>
          entry.threadId === threadId &&
          (userId === undefined || queueEntryOwnerId(entry) === userId) &&
          (targetCatId === undefined || entry.targets.includes(targetCatId)),
      );
  }

  /**
   * Read process-local provider attempts carrying any of the exact source
   * messages. Admitted attempts are deliberately absent from the durable
   * pending Queue, so execution evidence must never rediscover them through
   * the ledger.
   */
  findAdmittedEntriesForMessages(
    threadId: string,
    messageIds: readonly string[],
    userId?: string,
    targetCatId?: string,
  ): QueueEntry[] {
    const wanted = new Set(messageIds);
    if (wanted.size === 0) return [];
    return [...this.admittedEntries.values()]
      .flat()
      .filter(
        (entry) =>
          entry.threadId === threadId &&
          (userId === undefined || queueEntryOwnerId(entry) === userId) &&
          (targetCatId === undefined || entry.targets.includes(targetCatId)) &&
          queueEntryMessageIds(entry).some((messageId) => wanted.has(messageId)),
      )
      .map((entry) => structuredClone(entry));
  }

  /** Process-local prompt transport evidence for one admitted attempt; never persisted on Queue state. */
  getAdmittedAttemptEvidence(
    threadId: string,
    entryId: string,
    targetCatId: string,
    userId?: string,
  ): Readonly<AdmittedAttemptEvidence> | null {
    const admitted = this.findAdmittedEntry(threadId, entryId, targetCatId, userId);
    if (!admitted) return null;
    const evidence = this.admittedAttemptEvidence.get(admitted);
    return evidence ? { ...evidence } : null;
  }

  private forgetAdmittedEntry(threadId: string, entryId: string, targetCatId?: string): QueueEntry | null {
    const entries = this.admittedEntries.get(entryId);
    if (!entries) return null;
    const index = entries.findIndex(
      (entry) => entry.threadId === threadId && (targetCatId === undefined || entry.targets.includes(targetCatId)),
    );
    if (index < 0) return null;
    const [removed] = entries.splice(index, 1);
    if (entries.length === 0) this.admittedEntries.delete(entryId);
    return removed ? structuredClone(removed) : null;
  }

  private cacheLedgerClaim(entries: readonly QueueLedgerEntry[], claimId: string): QueueEntry[] {
    const projected = this.cacheLedgerEntries(entries);
    for (const entry of projected) {
      const cached = this.findEntry(entry.threadId, queueEntryOwnerId(entry), entry.id);
      if (!cached) continue;
      if (projected.length > 1) {
        cached.retiringGroupId = claimId;
        entry.retiringGroupId = claimId;
      }
      this.ledgerClaimIds.set(cached.id, claimId);
    }
    return projected.map((entry) => this.getEntrySnapshot(entry.threadId, queueEntryOwnerId(entry), entry.id) ?? entry);
  }

  async claimExactSteerEntryDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    claimedAt = Date.now(),
  ): Promise<DurableSteerClaimResult> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry) return { outcome: 'rejected', reason: 'entry_not_found' };
    if (entry.status !== 'queued') return { outcome: 'rejected', reason: 'entry_processing' };
    const assignsTargetlessConversation = entry.kind === 'conversation_input' && entry.targets.length === 0;
    if (
      isSystemPinnedQueueEntry(entry) ||
      (!assignsTargetlessConversation && !isOrdinaryQueueTargetEligible(entry, targetCatId))
    ) {
      return { outcome: 'rejected', reason: 'entry_ineligible' };
    }
    const claimId = randomUUID();
    const claimed = await this.ledgerStore.claim(threadId, entryId, claimId, claimedAt, targetCatId, claimedAt);
    if (claimed.outcome !== 'claimed') {
      return {
        outcome: 'rejected',
        reason: claimed.outcome === 'not_found' ? 'entry_not_found' : 'entry_processing',
      };
    }
    return { outcome: 'claimed', entries: this.cacheLedgerClaim(claimed.entries, claimId), targetCatId };
  }

  /**
   * Bind one public human message to the selected member and persist the
   * author's non-interrupting delivery intent. This is the Queue-panel
   * counterpart of composer admission: the same row either appends to the
   * exact current run or remains ordinary next work without canceling it.
   */
  async bindContinueCurrentIntentDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    authorIntent: QueueAuthorIntent,
    at = Date.now(),
  ): Promise<QueueEntry | null> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      entry.kind !== 'conversation_input' ||
      entry.from.kind !== 'user' ||
      isSystemPinnedQueueEntry(entry)
    ) {
      return null;
    }
    const assignsTargetlessConversation = entry.targets.length === 0;
    if (!assignsTargetlessConversation && !isOrdinaryQueueTargetEligible(entry, targetCatId)) return null;

    const claimId = randomUUID();
    const claimed = await this.ledgerStore.claim(
      threadId,
      entryId,
      claimId,
      at,
      assignsTargetlessConversation ? targetCatId : undefined,
    );
    if (claimed.outcome !== 'claimed' || !claimed.entries[0]) return null;
    const replacement = structuredClone(claimed.entries[0]);
    replacement.delivery.authorIntentByTarget = {
      ...(replacement.delivery.authorIntentByTarget ?? {}),
      [targetCatId]: structuredClone(authorIntent),
    };
    const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'queued', at, replacement);
    if (committed.outcome !== 'updated') {
      await this.ledgerStore.restore(threadId, entryId, claimId, assignsTargetlessConversation);
      return null;
    }
    const [bound] = this.cacheLedgerEntries([committed.entry]);
    return bound ? structuredClone(bound) : null;
  }

  /** Record the truthful next-work fallback after an exact Append race. */
  async fallbackQueuedAuthorIntentDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    reason: QueueAuthorIntentFallbackReason,
    at = Date.now(),
  ): Promise<boolean> {
    const result = await this.mutateQueuedLedgerEntry(threadId, userId, entryId, (row) => {
      const intent = row.delivery.authorIntentByTarget?.[targetCatId];
      if (!intent || intent.requested !== 'continue_current' || intent.fallbackAt !== undefined) return false;
      row.delivery.authorIntentByTarget = {
        ...(row.delivery.authorIntentByTarget ?? {}),
        [targetCatId]: { ...intent, fallbackAt: at, fallbackReason: reason },
      };
      return true;
    });
    return result?.changed ?? false;
  }

  async restoreClaimedEntries(threadId: string, entryIds: readonly string[]): Promise<boolean> {
    let restoredAll = true;
    for (const entryId of entryIds) {
      const claimId = this.ledgerClaimIds.get(entryId);
      if (!claimId) {
        restoredAll = false;
        continue;
      }
      // The durable claim records whether this action bound a formerly
      // targetless entry. Never infer that from the v2 source-derived id: every
      // v2 row has that identity, including already-targeted rows.
      const restored = await this.ledgerStore.restore(threadId, entryId, claimId);
      if (restored.outcome !== 'updated') {
        restoredAll = false;
        continue;
      }
      this.ledgerClaimIds.delete(entryId);
      this.cacheLedgerEntries([restored.entry]);
    }
    return restoredAll;
  }

  /** Claim one queued row before an external withdrawal side effect. */
  async claimQueuedEntryForWithdrawal(threadId: string, userId: string, entryId: string): Promise<QueueEntry | null> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry || entry.status !== 'queued') return null;
    return this.claimLedgerEntry(entry);
  }

  /** Freeze the source entry for one message before its withdrawal side effect. */
  async claimMessageEntriesForWithdrawal(
    threadId: string,
    userId: string,
    messageId: string,
    claimedAt = Date.now(),
  ): Promise<DurableMessageClaimResult> {
    const matches = [...this.queues.values()]
      .flat()
      .filter((entry) => entry.threadId === threadId && entry.payload.messageId === messageId);
    if (matches.length === 0 || matches.some((entry) => queueEntryOwnerId(entry) !== userId)) {
      return { outcome: 'not_found' };
    }
    if (matches.some((entry) => entry.status !== 'queued')) return { outcome: 'processing' };
    const claimId = randomUUID();
    const claimed = await this.ledgerStore.claimPrefix(
      threadId,
      matches.map((entry) => entry.id),
      claimId,
      claimedAt,
    );
    if (claimed.outcome !== 'claimed') {
      return { outcome: claimed.outcome === 'not_found' ? 'not_found' : 'processing' };
    }
    return { outcome: 'claimed', entries: this.cacheLedgerClaim(claimed.entries, claimId) };
  }

  /** Withdraw every source entry frozen by claimMessageEntriesForWithdrawal. */
  async commitClaimedMessageWithdrawal(threadId: string, entryIds: readonly string[]): Promise<boolean> {
    let committedAll = true;
    for (const entryId of entryIds) {
      if (!(await this.commitClaimedWithdrawal(threadId, entryId))) committedAll = false;
    }
    return committedAll;
  }

  /** Remove a withdrawal claim after its source-message terminal write succeeds. */
  async commitClaimedWithdrawal(threadId: string, entryId: string): Promise<QueueEntry | null> {
    const claimId = this.ledgerClaimIds.get(entryId);
    if (!claimId) return null;
    const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'withdrawn', Date.now());
    if (committed.outcome !== 'updated') return null;
    this.ledgerClaimIds.delete(entryId);
    return this.removeCachedEntry(threadId, entryId);
  }

  /** Persist explicit ordering through the same claim/commit CAS as dequeue. */
  async setPositionDurable(threadId: string, userId: string, entryId: string, position: number): Promise<boolean> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      entry.kind === 'private_input' ||
      isSystemPinnedQueueEntry(entry) ||
      !Number.isInteger(position) ||
      position < 0
    ) {
      return false;
    }
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const claimed = await this.ledgerStore.claim(threadId, entryId, claimId, claimedAt);
    if (claimed.outcome !== 'claimed' || !claimed.entries[0]) return false;
    const replacement = structuredClone(claimed.entries[0]);
    replacement.position = position;
    const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'queued', claimedAt, replacement);
    if (committed.outcome !== 'updated') {
      await this.ledgerStore.restore(threadId, entryId, claimId);
      return false;
    }
    this.cacheLedgerEntries([committed.entry]);
    return true;
  }

  /**
   * Apply a queued-row metadata mutation through the existing ledger claim/commit
   * CAS. This deliberately reuses the five ADR-043 primitives instead of adding
   * a side-channel persistence API for receipts.
   */
  private async mutateQueuedLedgerEntry(
    threadId: string,
    userId: string,
    entryId: string,
    mutate: (entry: QueueLedgerEntry) => boolean,
  ): Promise<{ changed: boolean; entry: QueueEntry } | null> {
    const cached = this.findEntry(threadId, userId, entryId);
    if (!cached || cached.status !== 'queued') return null;
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const claimed = await this.ledgerStore.claim(threadId, entryId, claimId, claimedAt);
    if (claimed.outcome !== 'claimed' || !claimed.entries[0]) return null;
    const replacement = structuredClone(claimed.entries[0]);
    let changed: boolean;
    try {
      changed = mutate(replacement);
    } catch (error) {
      await this.ledgerStore.restore(threadId, entryId, claimId);
      throw error;
    }
    const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'queued', claimedAt, replacement);
    if (committed.outcome !== 'updated') {
      await this.ledgerStore.restore(threadId, entryId, claimId);
      return null;
    }
    const [entry] = this.cacheLedgerEntries([committed.entry]);
    return entry ? { changed, entry } : null;
  }

  async requestReminderDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    reminderId: string,
    requestedAt = Date.now(),
  ): Promise<{ attempt: QueueReminderAttempt; idempotent: boolean } | null> {
    let attempt: QueueReminderAttempt | undefined;
    let idempotent = false;
    const result = await this.mutateQueuedLedgerEntry(threadId, userId, entryId, (row) => {
      if (!row.targets.includes(targetCatId)) return false;
      const existing = row.delivery.reminderAttempts?.find(
        (candidate) => candidate.targetCatId === targetCatId && candidate.invocationId === invocationId,
      );
      if (existing) {
        attempt = structuredClone(existing);
        idempotent = true;
        return false;
      }
      attempt = {
        id: reminderId,
        targetCatId,
        invocationId,
        state: 'requested',
        requestedAt,
      };
      row.delivery.reminderAttempts = [...(row.delivery.reminderAttempts ?? []), attempt];
      return true;
    });
    return result && attempt ? { attempt, idempotent } : null;
  }

  async markProcessingAwakened(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    awakenedAt = Date.now(),
  ): Promise<boolean> {
    const admitted = this.findAdmittedEntry(threadId, entryId, targetCatId, userId);
    if (!admitted) return false;
    const evidence = this.admittedAttemptEvidence.get(admitted) ?? {};
    if (evidence.awakenedInvocationId && evidence.awakenedInvocationId !== invocationId) return false;
    evidence.awakenedInvocationId ??= invocationId;
    evidence.awakenedAt ??= awakenedAt;
    this.admittedAttemptEvidence.set(admitted, evidence);
    return true;
  }

  async markProcessingSeen(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    seenAt = Date.now(),
  ): Promise<{ changed: boolean; newlySeen: boolean }> {
    const admitted = this.findAdmittedEntry(threadId, entryId, targetCatId, userId);
    if (!admitted) return { changed: false, newlySeen: false };
    const evidence = this.admittedAttemptEvidence.get(admitted) ?? {};
    const newlySeen = evidence.seenAt === undefined;
    const changed = newlySeen || evidence.seenInvocationId !== invocationId;
    evidence.seenAt ??= seenAt;
    evidence.seenInvocationId = invocationId;
    this.admittedAttemptEvidence.set(admitted, evidence);
    return { changed, newlySeen };
  }

  /** Claim one exact pending target on its source entry before binding a full-body read to the active child. */
  async claimExactExposureDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    messageId: string,
  ): Promise<QueueEntry | null> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      !entry.targets.includes(targetCatId) ||
      entry.payload.messageId !== messageId
    ) {
      return null;
    }
    return this.claimLedgerEntry(entry, targetCatId);
  }

  /**
   * Remove the adopted target from durable Queue and retain only process-local
   * attempt evidence. History already owns the exact source→target dispatch.
   */
  async commitClaimedAdoptionDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    seenAt: number,
  ): Promise<{ entry: QueueEntry; newlySeen: boolean } | null> {
    const snapshot = this.getEntrySnapshot(threadId, userId, entryId);
    const claimId = this.ledgerClaimIds.get(entryId);
    if (!snapshot || snapshot.status !== 'claimed' || !claimId) return null;
    const durable = await this.ledgerStore.get(threadId, entryId);
    if (!durable || !durable.targets.includes(targetCatId)) return null;
    const admitted = await this.ledgerStore.commit(threadId, entryId, claimId, 'processing', seenAt, durable);
    if (admitted.outcome !== 'updated') return null;
    this.ledgerClaimIds.delete(entryId);
    this.removeCachedEntry(threadId, entryId);
    const remaining = await this.ledgerStore.get(threadId, entryId);
    if (remaining) this.cacheLedgerEntries([remaining]);
    return { entry: admitted.entry, newlySeen: true };
  }

  async claimPreAdmissionFailureAcrossUsersDurable(threadId: string, entryId: string): Promise<QueueEntry | null> {
    const best = this.peekOldestAcrossUsers(threadId);
    if (!best || best.id !== entryId) return null;
    return this.claimLedgerEntry(best);
  }

  /** Durable counterpart of markProcessingAcrossUsers. */
  async markProcessingDurable(
    threadId: string,
    userId: string,
    resolvedHead: { readonly entryId: string; readonly targetCats: readonly string[] },
  ): Promise<QueueEntry | null> {
    const best = this.peekNextQueued(threadId, userId);
    if (
      !best ||
      best.id !== resolvedHead.entryId ||
      resolvedHead.targetCats.length === 0 ||
      resolvedHead.targetCats.some((catId) => typeof catId !== 'string' || !catId) ||
      new Set(resolvedHead.targetCats).size !== resolvedHead.targetCats.length
    ) {
      return null;
    }
    const selectedTargetCatId = resolvedHead.targetCats[0]!;
    if (best.targets.length > 0 && !best.targets.includes(selectedTargetCatId)) return null;
    return this.claimLedgerEntry(best, selectedTargetCatId);
  }

  /** Durable counterpart of markProcessingAcrossUsers. */
  async markProcessingAcrossUsersDurable(
    threadId: string,
    resolvedHead: { readonly entryId: string; readonly targetCats: readonly string[] },
  ): Promise<QueueEntry | null> {
    const best = this.peekOldestAcrossUsers(threadId);
    if (
      !best ||
      best.id !== resolvedHead.entryId ||
      resolvedHead.targetCats.length === 0 ||
      resolvedHead.targetCats.some((catId) => typeof catId !== 'string' || !catId) ||
      new Set(resolvedHead.targetCats).size !== resolvedHead.targetCats.length
    ) {
      return null;
    }
    const selectedTargetCatId = resolvedHead.targetCats[0]!;
    if (best.targets.length > 0 && !best.targets.includes(selectedTargetCatId)) return null;
    return this.claimLedgerEntry(best, selectedTargetCatId);
  }

  async markProcessingGroupAcrossUsersDurable(
    threadId: string,
    resolvedHead: { readonly entryId: string; readonly targetCats: readonly string[] },
    entryIds: readonly string[],
  ): Promise<{ entry: QueueEntry; members: QueueEntry[] } | null> {
    const best = this.peekOldestAcrossUsers(threadId);
    if (
      !best ||
      best.id !== resolvedHead.entryId ||
      entryIds[0] !== best.id ||
      entryIds.length === 0 ||
      new Set(entryIds).size !== entryIds.length ||
      resolvedHead.targetCats.length !== 1
    ) {
      return null;
    }
    const selectedTargetCatId = resolvedHead.targetCats[0]!;
    const selected = entryIds.map((entryId) => this.findEntryAcrossUsers(threadId, entryId));
    if (
      selected.some(
        (entry) =>
          !entry ||
          entry.status !== 'queued' ||
          queueEntryOwnerId(entry) !== queueEntryOwnerId(best) ||
          (entry.targets.length > 0 && !entry.targets.includes(selectedTargetCatId)),
      )
    ) {
      return null;
    }
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const claimed = await this.ledgerStore.claimPrefix(threadId, entryIds, claimId, claimedAt, selectedTargetCatId);
    if (claimed.outcome !== 'claimed') return null;
    const projected = this.cacheLedgerClaim(claimed.entries, claimId);
    const byId = new Map(projected.map((entry) => [entry.id, entry]));
    const primary = byId.get(best.id);
    if (!primary) return null;
    return {
      entry: primary,
      members: entryIds
        .slice(1)
        .map((entryId) => byId.get(entryId))
        .filter((entry): entry is QueueEntry => !!entry),
    };
  }

  async markProcessingGroupDurable(
    threadId: string,
    userId: string,
    resolvedHead: { readonly entryId: string; readonly targetCats: readonly string[] },
    entryIds: readonly string[],
  ): Promise<{ entry: QueueEntry; members: QueueEntry[] } | null> {
    const best = this.peekNextQueued(threadId, userId);
    if (
      !best ||
      best.id !== resolvedHead.entryId ||
      entryIds[0] !== best.id ||
      entryIds.length === 0 ||
      new Set(entryIds).size !== entryIds.length ||
      resolvedHead.targetCats.length !== 1
    ) {
      return null;
    }
    const selectedTargetCatId = resolvedHead.targetCats[0]!;
    const selected = entryIds.map((entryId) => this.findEntry(threadId, userId, entryId));
    if (
      selected.some(
        (entry) =>
          !entry ||
          entry.status !== 'queued' ||
          (entry.targets.length > 0 && !entry.targets.includes(selectedTargetCatId)),
      )
    ) {
      return null;
    }
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const claimed = await this.ledgerStore.claimPrefix(threadId, entryIds, claimId, claimedAt, selectedTargetCatId);
    if (claimed.outcome !== 'claimed') return null;
    const projected = this.cacheLedgerClaim(claimed.entries, claimId);
    const byId = new Map(projected.map((entry) => [entry.id, entry]));
    const primary = byId.get(best.id);
    if (!primary) return null;
    return {
      entry: primary,
      members: entryIds
        .slice(1)
        .map((entryId) => byId.get(entryId))
        .filter((entry): entry is QueueEntry => !!entry),
    };
  }

  async markProcessingByIdDurable(threadId: string, entryId: string, targetCatId: string): Promise<QueueEntry | null> {
    const entry = this.findEntryAcrossUsers(threadId, entryId);
    if (!entry || entry.status !== 'queued') return null;
    if (entry.targets.length > 0 && !entry.targets.includes(targetCatId)) return null;
    return this.claimLedgerEntry(entry, targetCatId);
  }

  async commitClaimedProcessing(threadId: string, entryIds: readonly string[], at = Date.now()): Promise<boolean> {
    for (const entryId of entryIds) {
      const claimId = this.ledgerClaimIds.get(entryId);
      if (!claimId) continue;
      const cached = this.findEntryAcrossUsers(threadId, entryId);
      const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'processing', at, cached);
      if (committed.outcome !== 'updated') return false;
      this.ledgerClaimIds.delete(entryId);
      this.removeCachedEntry(threadId, entryId);
      const remaining = await this.ledgerStore.get(threadId, entryId);
      if (remaining) this.cacheLedgerEntries([remaining]);
      this.rememberAdmittedEntry(committed.entry);
    }
    return true;
  }

  async rollbackProcessingDurable(threadId: string, entryId: string): Promise<boolean> {
    const claimId = this.ledgerClaimIds.get(entryId);
    if (!claimId) return false;
    const restored = await this.ledgerStore.restore(threadId, entryId, claimId);
    if (restored.outcome !== 'updated') return false;
    this.ledgerClaimIds.delete(entryId);
    this.cacheLedgerEntries([restored.entry]);
    return true;
  }

  private removeCachedEntry(threadId: string, entryId: string): QueueEntry | null {
    for (const queue of this.queues.values()) {
      if (!this.queueMatchesThread(queue, threadId)) continue;
      const index = queue.findIndex((entry) => entry.id === entryId);
      if (index < 0) continue;
      return queue.splice(index, 1)[0] ?? null;
    }
    return null;
  }

  async removeProcessedAcrossUsersDurable(
    threadId: string,
    entryId: string,
    terminalOutcome: QueueAttemptSettlementOutcome = 'handled',
    failureReason?: QueueTargetAttemptTerminalReason,
    terminalAt = Date.now(),
  ): Promise<QueueEntry | null> {
    const admitted = this.forgetAdmittedEntry(threadId, entryId);
    if (admitted) return admitted;
    const snapshot = this.findEntryAcrossUsers(threadId, entryId);
    if (!snapshot || snapshot.status !== 'claimed') return null;
    const claimId = this.ledgerClaimIds.get(entryId);
    if (!claimId) return null;
    const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'withdrawn', terminalAt);
    if (committed.outcome !== 'updated') return null;
    this.ledgerClaimIds.delete(entryId);
    return this.removeCachedEntry(threadId, entryId);
  }

  async removeProcessedDurable(threadId: string, userId: string, entryId: string): Promise<QueueEntry | null> {
    const snapshot =
      this.getEntrySnapshot(threadId, userId, entryId) ?? this.findAdmittedEntry(threadId, entryId, undefined, userId);
    if (!snapshot) return null;
    return this.removeProcessedAcrossUsersDurable(threadId, entryId);
  }

  /** Terminalize one exact row without manufacturing a rollback path. */
  async terminalizeEntryDurable(
    threadId: string,
    userId: string,
    entryId: string,
    terminalOutcome: QueueAttemptSettlementOutcome = 'handled',
    failureReason?: QueueTargetAttemptTerminalReason,
  ): Promise<QueueEntry | null> {
    const snapshot = this.getEntrySnapshot(threadId, userId, entryId);
    if (!snapshot) return null;
    if (snapshot.status === 'queued') {
      const claimed = await this.claimQueuedEntryForWithdrawal(threadId, userId, entryId);
      if (!claimed) return null;
      if (!(await this.commitClaimedProcessing(threadId, [entryId]))) {
        await this.restoreClaimedEntries(threadId, [entryId]);
        return null;
      }
      return this.removeProcessedAcrossUsersDurable(threadId, entryId, terminalOutcome, failureReason);
    }
    // A reversible claim is projected as processing for legacy readers. Do not
    // steal another action's in-flight authority.
    if (this.ledgerClaimIds.has(entryId)) return null;
    return this.removeProcessedAcrossUsersDurable(threadId, entryId, terminalOutcome, failureReason);
  }

  async getDurableEntry(threadId: string, entryId: string): Promise<QueueLedgerEntry | null> {
    return this.ledgerStore.get(threadId, entryId);
  }

  async getDurableEntriesForMessages(
    threadId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, QueueLedgerEntry[]>> {
    return this.ledgerStore.getByMessageIds(threadId, messageIds);
  }

  /** Read every durable pending entry for recovery classification. */
  async listAllDurable(threadId: string): Promise<QueueLedgerEntry[]> {
    return this.ledgerStore.list(threadId);
  }

  /** Check if any entry in the thread already carries this messageId (connector retry dedup). */
  hasEntryWithMessageId(threadId: string, messageId: string): boolean {
    return this.findEntryWithMessageId(threadId, messageId) !== null;
  }

  /** Return the exact Queue carrier for a persisted message across user scopes. */
  findEntryWithMessageId(threadId: string, messageId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find((e) => e.payload.messageId === messageId);
      if (entry) return structuredClone(entry);
    }
    return null;
  }

  /** Backfill messageId on a new entry (null → value). */
  async retireActionSuccessorFenceDurable(fence: ActionSuccessorFence): Promise<ActionSuccessorQueueRetirement[]> {
    const retired: ActionSuccessorQueueRetirement[] = [];
    const matches = [...this.queues.values()]
      .flat()
      .filter((entry) => actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence));
    for (const entry of matches) {
      const ownerId = queueEntryOwnerId(entry);
      if (await this.terminalizeEntryDurable(entry.threadId, ownerId, entry.id)) {
        retired.push({
          entryId: entry.id,
          threadId: entry.threadId,
          userId: ownerId,
          messageIds: exactA2ASourceMessageIds(entry),
        });
      }
    }
    return retired;
  }

  /** Read the exact process carriers before durable custody retirement. */
  listActionSuccessorFence(fence: ActionSuccessorFence): ActionSuccessorQueueRetirement[] {
    const matches: ActionSuccessorQueueRetirement[] = [];
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        if (!actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence)) continue;
        matches.push({
          entryId: entry.id,
          threadId: entry.threadId,
          userId: queueEntryOwnerId(entry),
          messageIds: exactA2ASourceMessageIds(entry),
        });
      }
    }
    return matches;
  }

  /** Shallow copy of all entries sorted by dequeue priority (comparator order). */
  list(threadId: string, userId: string): QueueEntry[] {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return [];
    return [...q].sort(InvocationQueue.compareEntries).map((entry) => structuredClone(entry));
  }

  /** Canonical hydrated scopes used to resume pending ledger work after startup. */
  listScopes(): Array<{ threadId: string; userId: string }> {
    const scopes: Array<{ threadId: string; userId: string }> = [];
    for (const queue of this.queues.values()) {
      const first = queue[0];
      if (first) scopes.push({ threadId: first.threadId, userId: queueEntryOwnerId(first) });
    }
    return scopes;
  }

  /** Exact process-local Queue snapshot fence used by explicit row actions. */
  snapshotRevision(threadId: string, userId: string): string {
    return createHash('sha256')
      .update(JSON.stringify(this.list(threadId, userId)))
      .digest('base64url');
  }

  /**
   * Claim one selected public row without borrowing ordinary head-dequeue
   * semantics. Revision and the complete target set are checked in the same
   * synchronous mutation that crosses queued -> processing.
   */
  async claimExactAppend(
    threadId: string,
    userId: string,
    entryId: string,
    expectedQueueRevision: string,
    expectedTargetIds: readonly string[],
  ): Promise<QueueEntry | null> {
    if (this.snapshotRevision(threadId, userId) !== expectedQueueRevision) return null;
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      entry.kind === 'private_input' ||
      isSystemPinnedQueueEntry(entry) ||
      expectedTargetIds.length === 0 ||
      expectedTargetIds.length !== queueEntryTargetCats(entry).length ||
      expectedTargetIds.some((targetId, index) => targetId !== queueEntryTargetCats(entry)[index]) ||
      expectedTargetIds.some((targetId) => !isOrdinaryQueueTargetEligible(entry, targetId))
    ) {
      return null;
    }
    return this.claimLedgerEntry(entry);
  }

  /** Persist the exact Active Run body exposure before the Queue row is detached. */
  getEntrySnapshot(threadId: string, userId: string, entryId: string): QueueEntry | null {
    const entry = this.findEntry(threadId, userId, entryId);
    return entry ? structuredClone(entry) : null;
  }

  /** Resolve a durable carrier by its globally unique entry id without trusting a source-thread projection. */

  /** Restore one exact TTL-0 Queue owner after process restart or failed persistence. Idempotent by entryId. */
  getQueuedFreshnessMessagesForCat(
    threadId: string,
    userId: string,
    catId: string,
    opts?: { excludeEntryId?: string; parentInvocationId?: string },
  ): Array<{
    entryId: string;
    from: MessageFrom;
    content: string;
    messageId?: string | null;
    sourceCategory?: QueueEntry['sourceCategory'];
  }> {
    return this.list(threadId, userId)
      .filter((entry) => entry.id !== opts?.excludeEntryId)
      .filter((entry) => entry.status === 'queued' && isOrdinaryQueueTargetEligible(entry, catId))
      .filter((entry) => InvocationQueue.canExposeToCurrentParent(entry, catId, opts?.parentInvocationId))
      .map((entry) => ({
        entryId: entry.id,
        from: structuredClone(entry.from),
        content: entry.payload.content,
        ...(entry.payload.messageId !== undefined ? { messageId: entry.payload.messageId } : {}),
        ...(entry.sourceCategory ? { sourceCategory: entry.sourceCategory } : {}),
      }));
  }

  /** Queued bodies readable by a target cat until one exact active child adopts them. */
  getQueuedBodyMessagesForCat(
    threadId: string,
    userId: string,
    catId: string,
    parentInvocationId?: string,
  ): Array<{
    entryId: string;
    from: MessageFrom;
    content: string;
    messageId?: string | null;
    alreadyExposed: boolean;
    readDisposition: 'adopt' | 'seen_only';
  }> {
    return this.list(threadId, userId)
      .filter((entry) => entry.status === 'queued' && isOrdinaryQueueTargetEligible(entry, catId))
      .filter((entry) => InvocationQueue.canExposeToCurrentParent(entry, catId, parentInvocationId))
      .map((entry) => ({
        entryId: entry.id,
        from: structuredClone(entry.from),
        content: entry.payload.content,
        alreadyExposed: false,
        // A full-body read is actual delivery. Structured successor/hold truth
        // moves to its own store after adoption; Queue must not retain the
        // target merely to mirror that later lifecycle.
        readDisposition: entry.payload.messageId !== undefined ? 'adopt' : 'seen_only',
        ...(entry.payload.messageId !== undefined ? { messageId: entry.payload.messageId } : {}),
      }));
  }

  private static canExposeToCurrentParent(
    entry: Pick<QueueEntry, 'from' | 'delivery'>,
    catId: string,
    parentInvocationId: string | undefined,
  ): boolean {
    // Author disposition belongs only to human-authored work. Agent and connector
    // carriers retain their typed custody/continuation path and may be read at a
    // current safe boundary without manufacturing a human queue preference.
    if (entry.from.kind !== 'user') return true;
    const authorIntent = entry.delivery.authorIntentByTarget?.[catId];
    return Boolean(
      parentInvocationId &&
        authorIntent?.requested === 'continue_current' &&
        authorIntent.fallbackAt === undefined &&
        authorIntent.boundParentInvocationId === parentInvocationId,
    );
  }

  size(threadId: string, userId: string): number {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return 0;
    return q.filter((e) => e.status === 'queued').length;
  }

  /**
   * Move entry up or down in comparator order by swapping positions with its neighbor.
   * Returns false if entry is processing or not found.
   */
  peekNextQueued(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const queued = q.filter((entry) => entry.status === 'queued');
    if (queued.length === 0) return null;
    queued.sort(InvocationQueue.compareEntries);
    return structuredClone(queued[0]!);
  }

  /** Rollback a processing entry back to queued (undo markProcessing/markProcessingAcrossUsers). */
  peekOldestAcrossUsers(threadId: string): QueueEntry | null {
    let best: QueueEntry | null = null;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.status !== 'queued') continue;
        if (!best || InvocationQueue.compareEntries(e, best) < 0) {
          best = e;
        }
      }
    }
    return best ? { ...best } : null;
  }

  /** Mark the strict comparator head across users as processing. */
  getProcessingGroupAcrossUsers(threadId: string, entryId: string): QueueEntry[] | null {
    const selected = this.findAdmittedEntry(threadId, entryId) ?? this.findEntryAcrossUsers(threadId, entryId);
    if (!selected || (selected.status !== 'claimed' && selected.status !== 'processing')) return null;
    if (!selected.retiringGroupId) return [structuredClone(selected)];
    const group = [...this.queues.values(), ...this.admittedEntries.values()]
      .flatMap((entries) => entries)
      .filter(
        (entry) =>
          entry.threadId === threadId &&
          (entry.status === 'claimed' || entry.status === 'processing') &&
          entry.retiringGroupId === selected.retiringGroupId,
      );
    return group.length > 0 ? group.map((entry) => structuredClone(entry)) : null;
  }

  /**
   * Atomically tombstone one processing carrier and every member of its exact
   * Steer reservation. Supersession paths use this instead of treating the
   * primary row as the whole reservation. Ordinary attempt settlement remains
   * per-entry and must keep using removeProcessedAcrossUsers.
   */
  findProcessingByCat(threadId: string, catId: string, excludeEntryId?: string): QueueEntry | null {
    for (const q of [...this.queues.values(), ...this.admittedEntries.values()]) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find(
        (e) =>
          (e.status === 'claimed' || e.status === 'processing') && e.id !== excludeEntryId && e.targets.includes(catId),
      );
      if (entry) return structuredClone(entry);
    }
    return null;
  }

  /** Get unique userIds that have entries (any status) for this thread. */
  listUsersForThread(threadId: string): string[] {
    const users: string[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId) || q.length === 0) continue;
      users.push(queueEntryOwnerId(q[0]!));
    }
    return users;
  }

  /** F122B: List all queued autoExecute entries for a thread (for scanning past busy slots). */
  listAutoExecute(threadId: string): QueueEntry[] {
    const result: QueueEntry[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (
          e.status !== 'queued' ||
          !e.execution.autoExecute ||
          (e.targets.length > 0 && e.targets.every((catId) => !isOrdinaryQueueTargetEligible(e, catId)))
        )
          continue;
        result.push(structuredClone(e));
      }
    }
    return result;
  }

  /** F122B: Count queued+processing agent-sourced entries for a thread (depth tracking).
   *  Queued entries are valid pending work regardless of age; processing entries
   *  have their own stale guard in hasActiveOrQueuedAgentForCat/hasPendingForCat. */
  countAgentEntriesForThread(threadId: string): number {
    let count = 0;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.from.kind !== 'agent' || e.targets.length === 0) continue;
        count++;
      }
    }
    for (const entries of this.admittedEntries.values()) {
      count += entries.filter((entry) => entry.threadId === threadId && entry.from.kind === 'agent').length;
    }
    return count;
  }

  /** F122B: Check if a specific cat already has a queued agent entry for this thread.
   *  Used by callback-a2a-trigger for dedup — only checks 'queued' so that new handoffs
   *  can still be enqueued while an earlier entry is processing.
   */
  hasQueuedAgentForCat(threadId: string, catId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.from.kind === 'agent' && e.status === 'queued' && isQueueTargetPending(e, catId)) {
          return true;
        }
      }
    }
    return false;
  }

  /** Cross-path dedup guard for queued or live agent work targeting one cat. */
  hasActiveOrQueuedAgentForCat(threadId: string, catId: string, opts?: { excludeEntryId?: string }): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (opts?.excludeEntryId && e.id === opts.excludeEntryId) continue;
        if (e.from.kind !== 'agent' || !isQueueTargetPending(e, catId)) continue;

        if (e.status === 'claimed' || e.status === 'processing') {
          // Use processingStartedAt (when the entry actually began processing),
          // NOT createdAt (when it was enqueued). An entry may sit queued for a
          // long time before being picked up — using createdAt would falsely
          // expire it the moment it starts processing. (P1 fix per codex review)
          const processingAge = now - (e.processingStartedAt ?? e.claimedAt ?? e.enqueuedAt);
          if (processingAge < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) {
            this.log?.info(
              {
                threadId,
                catId,
                matchedEntry: {
                  entryId: e.id,
                  status: e.status,
                  processingAgeMs: processingAge,
                  owner: e.owner,
                },
              },
              '[DIAG] hasActiveOrQueuedAgentForCat hit',
            );
            return true;
          }
          // Stale processing — zombie defense
          this.log?.warn(
            {
              threadId,
              catId,
              matchedEntry: {
                entryId: e.id,
                status: e.status,
                processingAgeMs: processingAge,
                owner: e.owner,
              },
            },
            '[DIAG] hasActiveOrQueuedAgentForCat: ignoring stale processing entry (zombie defense)',
          );
          continue;
        }

        if (e.status === 'queued') {
          this.log?.info(
            {
              threadId,
              catId,
              matchedEntry: {
                entryId: e.id,
                status: e.status,
                queuedAgeMs: now - e.enqueuedAt,
                owner: e.owner,
              },
            },
            '[DIAG] hasActiveOrQueuedAgentForCat hit',
          );
          return true;
        }
      }
    }
    for (const entries of this.admittedEntries.values()) {
      if (
        entries.some(
          (entry) =>
            entry.threadId === threadId &&
            entry.id !== opts?.excludeEntryId &&
            entry.from.kind === 'agent' &&
            entry.targets.includes(catId),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Check for any queued/processing entry targeting a cat, optionally narrowed by source. */
  hasPendingForCat(
    threadId: string,
    catId: string,
    opts?: {
      excludeEntryId?: string;
      userId?: string;
      sources?: Array<ReturnType<typeof queueEntrySource>>;
      sourceCategories?: NonNullable<QueueEntry['sourceCategory']>[];
      continuationKey?: string;
    },
  ): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (opts?.excludeEntryId && e.id === opts.excludeEntryId) continue;
        if (opts?.userId && queueEntryOwnerId(e) !== opts.userId) continue;
        if (!isQueueTargetPending(e, catId)) continue;
        if (opts?.sources && !opts.sources.includes(queueEntrySource(e))) continue;
        if (opts?.sourceCategories) {
          if (!e.sourceCategory || !opts.sourceCategories.includes(e.sourceCategory)) continue;
        }
        if (opts?.continuationKey !== undefined && e.payload.sourceRecordId !== opts.continuationKey) continue;

        if (e.status === 'queued') {
          return true;
        }

        if (e.status === 'claimed' || e.status === 'processing') {
          const processingAge = now - (e.processingStartedAt ?? e.claimedAt ?? e.enqueuedAt);
          if (processingAge >= InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) {
            this.log?.warn(
              {
                threadId,
                catId,
                matchedEntry: {
                  entryId: e.id,
                  status: e.status,
                  processingAgeMs: processingAge,
                  owner: e.owner,
                },
              },
              '[DIAG] hasPendingForCat: ignoring stale processing entry (zombie defense)',
            );
            continue;
          }
          return true;
        }
      }
    }
    for (const entries of this.admittedEntries.values()) {
      for (const entry of entries) {
        if (entry.threadId !== threadId || !entry.targets.includes(catId)) continue;
        if (opts?.excludeEntryId && entry.id === opts.excludeEntryId) continue;
        if (opts?.userId && queueEntryOwnerId(entry) !== opts.userId) continue;
        if (opts?.sources && !opts.sources.includes(queueEntrySource(entry))) continue;
        if (
          opts?.sourceCategories &&
          (!entry.sourceCategory || !opts.sourceCategories.includes(entry.sourceCategory))
        ) {
          continue;
        }
        if (opts?.continuationKey !== undefined && entry.payload.sourceRecordId !== opts.continuationKey) continue;
        return true;
      }
    }
    return false;
  }

  /** F122B: Mark a specific entry as processing by ID (cross-user). */
  collectCompatibleConversationPrefix(
    head: QueueEntry | null | undefined,
    resolution?: {
      readonly routingClass: 'explicit' | 'targetless';
      readonly requestedTargets: readonly string[];
      readonly resolvedTargets: readonly string[];
    },
  ): QueueEntry[] {
    if (
      !head ||
      head.kind !== 'conversation_input' ||
      (resolution?.resolvedTargets ?? queueEntryTargetCats(head)).length === 0 ||
      head.position !== undefined ||
      head.delivery.steerRequestedAt !== undefined
    ) {
      return [];
    }

    const queued: QueueEntry[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, head.threadId)) continue;
      queued.push(...q.filter((entry) => entry.status === 'queued' && entry.id !== head.id));
    }
    queued.sort(InvocationQueue.compareEntries);

    const headTargets = sorted([...(resolution?.requestedTargets ?? queueEntryTargetCats(head))]);
    const routingClass = resolution?.routingClass ?? 'explicit';
    const prefix: QueueEntry[] = [];
    for (const candidate of queued) {
      if (
        candidate.kind !== 'conversation_input' ||
        queueEntryOwnerId(candidate) !== queueEntryOwnerId(head) ||
        candidate.execution.intent !== head.execution.intent ||
        candidate.execution.ownerAuthProvenance !== head.execution.ownerAuthProvenance ||
        candidate.position !== undefined ||
        candidate.delivery.steerRequestedAt !== undefined ||
        (routingClass === 'targetless'
          ? candidate.targets.length !== 0
          : !arraysEqual(sorted(queueEntryTargetCats(candidate)), headTargets)) ||
        (routingClass === 'explicit' &&
          queueEntryTargetCats(candidate).some((catId) => !isOrdinaryQueueTargetEligible(candidate, catId)))
      ) {
        break;
      }
      prefix.push(structuredClone(candidate));
    }
    return prefix;
  }

  /** #555: Whether a specific cat has any queued or processing entries in this thread (any source).
   *  Queued entries remain valid pending work regardless of age; only stale processing
   *  entries are ignored to prevent zombie entries from permanently blocking a cat. */
  hasQueuedOrProcessingForCat(threadId: string, catId: string): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (!isQueueTargetPending(e, catId)) continue;
        if (e.status === 'queued') {
          return true;
        }
        if (e.status === 'claimed' || e.status === 'processing') {
          const age = now - (e.processingStartedAt ?? e.claimedAt ?? e.enqueuedAt);
          if (age < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) return true;
        }
      }
    }
    for (const entries of this.admittedEntries.values()) {
      if (entries.some((entry) => entry.threadId === threadId && entry.targets.includes(catId))) return true;
    }
    return false;
  }

  /** Durable work remains thread-visible until an explicit admission or terminal transition removes it. */
  hasQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((entry) => entry.status === 'queued')) return true;
    }
    return false;
  }

  /** Whether ordinary scheduling has at least one queued row to select. */
  hasOrdinaryEligibleQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (
        q.some(
          (entry) =>
            entry.status === 'queued' &&
            (entry.targets.length === 0 || entry.targets.some((catId) => isOrdinaryQueueTargetEligible(entry, catId))),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Whether Queue still owns queued work for this thread. */
  hasDispatchableQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((e) => e.status === 'queued')) return true;
    }
    return false;
  }

  /** Whether a public conversation input is waiting; private/wake rows do not drive text-scan fairness. */
  hasQueuedConversationInputsForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((entry) => entry.status === 'queued' && entry.kind === 'conversation_input')) return true;
    }
    return false;
  }

  // ── Internal helpers ──

  private findEntry(threadId: string, userId: string, entryId: string): QueueEntry | undefined {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    return q?.find((e) => e.id === entryId);
  }
}

/** Sort a string array (returns new array). */
function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

/** Compare two sorted string arrays for equality. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
