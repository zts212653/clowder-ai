/**
 * InvocationQueue
 * Per-thread, per-user FIFO 队列，用于猫猫在跑时排队用户/connector 消息。
 *
 * 与 InvocationTracker（互斥锁，跟踪活跃调用）互补：
 * - InvocationTracker: "谁在跑"
 * - InvocationQueue: "谁在等"
 *
 * scopeKey = `${threadId}:${userId}` — 存储层天然用户隔离。
 * 系统级出队（invocation 完成后）通过 *AcrossUsers 方法跨用户 FIFO。
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  CatRoutingError,
  MessageFrom,
  QueueAuthorIntent,
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
import type { QueueBodyExposure, QueuePrestartRetirementIntent } from '../../stores/ports/queued-message-custody.js';
import type { ToolExecutionPolicy } from '../../types.js';
import { compareLifecycleQueueEntries } from './message-lifecycle-queue-order.js';
import type { OwnerAuthProvenance } from './owner-auth-provenance.js';

export interface QueueEntry {
  id: string;
  threadId: string;
  userId: string;
  /** Canonical RFC #1356 admission shape; private inputs never enter public Queue projections. */
  kind: 'conversation_input' | 'message_wake' | 'private_input';
  /** Internal-only owner authentication provenance; presentation projections must redact it. */
  ownerAuthProvenance: OwnerAuthProvenance;
  /** Optional request-level idempotency key for API replay dedup. */
  idempotencyKey?: string;
  content: string;
  messageId: string | null;
  mergedMessageIds: string[];
  /** RFC #1356: the single sender identity shared with History. */
  from: MessageFrom;
  targetCats: string[];
  /** Structured mention/parser warnings that stay attached to this inline payload. */
  routingWarnings?: CatRoutingError[];
  /** Stable target identity for glass-box projection after individual targets are handled. */
  allTargetCats?: string[];
  /** F264: per-target human author intent. Missing user records use legacy next_work compatibility. */
  authorIntentByCatId?: Record<string, QueueAuthorIntent>;
  /** Notice reached a safe boundary, but the queued body has not been read yet. */
  queuedNotifiedByCatIds?: string[];
  /** Exact child invocation created for this target before prompt-body exposure. */
  queuedAwakenedInvocationIdByCatId?: Record<string, string>;
  /** Immutable child-creation time paired with queuedAwakenedInvocationIdByCatId. */
  queuedAwakenedAtByCatId?: Record<string, number>;
  /** F254 D1.2a: per-cat read marker for queued body exposure. Seen suppresses freshness nag, not work. */
  queuedSeenByCatIds?: string[];
  /**
   * F254 D1.2b: per-cat invocation that read the queued body.
   * Used only as handled evidence; queuedSeenByCatIds remains the nag-suppression marker.
   */
  queuedSeenInvocationIdByCatId?: Record<string, string>;
  /** Exact, append-only child invocation body exposures for durable receipt projection. */
  queuedBodyExposures?: QueueBodyExposure[];
  /** The reading invocation failed/canceled; responsibility remains queued. */
  queuedFailedByCatIds?: string[];
  /** Exact terminal fact for the currently active target attempt. */
  queuedFailureAtByCatId?: Record<string, number>;
  queuedFailureReasonByCatId?: Record<string, QueueTargetAttemptTerminalReason>;
  /** Gate 5: restart-stable identity of the latest durable retry attempt per target. */
  queuedAttemptIdByCatId?: Record<string, string>;
  /** Historical target closure retained while sibling targets remain queued. */
  queuedHandledByCatIds?: string[];
  /** F264: accepted Steer awaiting replacement invocation identity. */
  steerRequestedByCatIds?: string[];
  /** F264: exact replacement invocation after provider-start read binding. */
  steeredInvocationIdByCatId?: Record<string, string>;
  /**
   * #1291 Gate 6: process-local exact Batch Steer reservation.
   *
   * This is deliberately not a second durable ledger. Durable per-message Queue
   * custody remains authoritative; this marker only fences dequeue so F175 cannot
   * absorb an unselected adjacent entry between reservation and replacement start.
   */
  exactSteerBatch?: ExactSteerBatchReservation;
  /** Restart-stable exact group fence while pre-start supersession terminalizes durable carriers. */
  prestartRetirement?: QueuePrestartRetirementIntent;
  intent: string;
  status: 'queued' | 'processing';
  createdAt: number;
  /** Set when entry transitions to 'processing'. Used for stale-processing TTL. */
  processingStartedAt?: number;
  /** F122B: auto-execute without waiting for steer/manual trigger */
  autoExecute: boolean;
  /**
   * Process-local fence while one persisted A2A trigger is binding its complete
   * fan-out custody. Ordinary selectors must not publish any carrier from this
   * admission before the canonical MessageStore CAS commits the whole group.
   *
   * The fence itself is process-local. MessageStore persists the corresponding
   * QueueCustodyAdmissionIntent after policy decisions but before these carriers
   * are staged, so startup reconstructs only the accepted subset and converges
   * rejected targets directly into full-custody failure state.
   */
  queueCustodyAdmissionId?: string;
  /** Source invocation lineage. Parallel invocations of one cat must not coalesce with each other. */
  a2aParentInvocationId?: string;
  /** F175: queue-internal priority — urgent entries sort before normal in dequeue */
  priority: 'urgent' | 'normal';
  /** F175: origin category for visual grouping */
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'continuation' | 'issue' | 'freshness';
  /** Queue-internal dedup key for agent control-flow work. */
  continuationKey?: string;
  /** F254 Phase E: typed custody carrier for one persistent catch closure. */
  freshnessClosureId?: string;
  freshnessRequiredFrontierMessageId?: string;
  /** ADR-042 distinct supplement carrier; never aliases freshnessClosureId. */
  freshnessSupplementId?: string;
  freshnessSupplementLineageId?: string;
  freshnessSupplementSeq?: 1 | 2;
  readOnlyToolPolicy?: ToolExecutionPolicy;
  /** F167 Phase S: persistent action lease generation fence across queue/start/commit. */
  actionSuccessorFence?: ActionSuccessorFence;
  /** #1291 Gate 4: immutable projection of the canonical wait owner fence. */
  waitContinuationCarrier?: WaitContinuationCarrierV1;
  /** F175: user drag-reorder position — explicit values override priority in dequeue */
  position?: number;
  /** F175: skill hint for connector triggers — flows through as promptTags on execution */
  suggestedSkill?: string;
  callerTraceContext?: CallerTraceContext;
  /** Explicit A2A trigger message for stream reply threading. */
  a2aTriggerMessageId?: string;
}

/**
 * The replacement fence must cover the original A2A trigger and every still
 * durable body in the carrier. After settlement, the primary body may differ
 * from the original trigger, so neither field is a safe stand-in for the
 * other.
 */
export function exactA2ASourceMessageIds(
  entry: Pick<QueueEntry, 'a2aTriggerMessageId' | 'messageId' | 'mergedMessageIds'>,
): string[] {
  return [
    ...new Set(
      [entry.a2aTriggerMessageId, entry.messageId, ...entry.mergedMessageIds].filter(
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

export interface ExactSteerBatchReservation {
  reservationId: string;
  primaryEntryId: string;
  entryIds: string[];
  targetCatId: string;
}

export type ExactUserBatchReservationResult =
  | ({ outcome: 'reserved' } & ExactSteerBatchReservation)
  | {
      outcome: 'rejected';
      reason: 'invalid_entry_ids' | 'entry_not_found' | 'entry_ineligible' | 'entries_incompatible';
    };

export type ExactUserEntryReservationResult =
  | ({ outcome: 'reserved' } & ExactSteerBatchReservation)
  | { outcome: 'rejected'; reason: 'state_changed' };

export interface ActivatedExactSteerReservation {
  reservationId: string;
  entry: QueueEntry;
}

export interface QueuedHandledResult {
  entryId: string;
  threadId: string;
  userId: string;
  catId: string;
  messageIds: string[];
  remainingTargetCats: string[];
  fullyConsumed: boolean;
  /** F254 D1.2b: rollback payload used when delivery persistence fails after tentative consume. */
  entrySnapshot?: QueueEntry;
  queueIndex?: number;
  originalContent?: string;
}

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
 * Queue entry ids are process-local UUIDs. An ActionSuccessor retry must instead
 * bind durable admission to the lease/generation idempotency key that survives a
 * restart, otherwise a lost in-memory queue can execute the same carrier twice.
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

export function isSystemPinnedQueueEntry(entry: Pick<QueueEntry, 'from' | 'sourceCategory'>): boolean {
  return entry.from.kind === 'agent' && entry.sourceCategory === 'continuation';
}

/**
 * Ordinary Queue target-selection paths must never reopen a target whose latest
 * attempt is terminal-failed. The entry itself may still carry eligible siblings
 * or remain visible to lifecycle/recovery code.
 */
export function isOrdinaryQueueTargetEligible(
  entry: Pick<QueueEntry, 'targetCats' | 'queuedFailedByCatIds' | 'queueCustodyAdmissionId'>,
  catId: string,
): boolean {
  return !entry.queueCustodyAdmissionId && isQueueTargetPending(entry, catId);
}

/** Pending ownership includes a carrier fenced behind an in-flight custody CAS. */
function isQueueTargetPending(entry: Pick<QueueEntry, 'targetCats' | 'queuedFailedByCatIds'>, catId: string): boolean {
  return entry.targetCats.includes(catId) && !entry.queuedFailedByCatIds?.includes(catId);
}

export class InvocationQueue {
  private readonly log = createModuleLogger('invocation-queue');
  private queues = new Map<string, QueueEntry[]>();
  private lastEnqueuedAt = 0;

  /** Original content per entryId at enqueue time, for rollbackEnqueue */
  private originalContents = new Map<string, string>();

  /** Rollback snapshots for the short reservation→preempt→dequeue window. */
  private exactSteerReservations = new Map<
    string,
    {
      threadId: string;
      userId: string;
      primaryEntryId: string;
      targetCatId: string;
      entries: Map<string, QueueEntry>;
      phase: 'reserved' | 'preempting' | 'activated';
    }
  >();

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

  private static normalizedPriority(input: { priority?: QueueEntry['priority'] }): QueueEntry['priority'] {
    return input.priority ?? 'normal';
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
      { id: a.id, priority: a.priority, enqueuedAt: a.createdAt, position: a.position },
      { id: b.id, priority: b.priority, enqueuedAt: b.createdAt, position: b.position },
    );
  }

  /** F175: set explicit dequeue position for drag-reorder. */
  setPosition(threadId: string, userId: string, entryId: string, position: number): boolean {
    const e = this.findEntry(threadId, userId, entryId);
    if (!e || e.status !== 'queued') return false;
    if (e.kind === 'private_input') return false;
    if (e.exactSteerBatch) return false;
    if (isSystemPinnedQueueEntry(e)) return false;
    e.position = position;
    return true;
  }

  /**
   * 预留队列位。容量检查在此完成。
   * 同源同目标的连续消息自动合并。
   */
  enqueue(
    input: Omit<
      QueueEntry,
      | 'id'
      | 'status'
      | 'createdAt'
      | 'mergedMessageIds'
      | 'messageId'
      | 'autoExecute'
      | 'priority'
      | 'position'
      | 'suggestedSkill'
      | 'ownerAuthProvenance'
      | 'exactSteerBatch'
    > & {
      ownerAuthProvenance: OwnerAuthProvenance;
      autoExecute?: boolean;
      priority?: 'urgent' | 'normal';
      suggestedSkill?: string;
      messageId?: string | null;
      /** Defaults true for request replay dedupe; connector coalescing can opt out for in-flight entries. */
      dedupeProcessing?: boolean;
    },
  ): EnqueueResult {
    const { ownerAuthProvenance } = InvocationQueue.requireAdmissionContract(input);
    const key = this.scopeKey(input.threadId, input.userId);
    const q = this.getOrCreate(key);
    const priority = InvocationQueue.normalizedPriority(input);
    const dedupeProcessing = input.dedupeProcessing ?? true;

    // Request replay dedupe: if an active entry already exists for this key in this scope,
    // return it instead of creating a second queue row.
    if (input.idempotencyKey) {
      const existing = q.find(
        (entry) =>
          entry.idempotencyKey === input.idempotencyKey &&
          (entry.status === 'queued' || (dedupeProcessing && entry.status === 'processing')),
      );
      if (existing) {
        if (existing.status === 'queued') {
          const upgradedPriority = priority === 'urgent' && existing.priority === 'normal';
          if (upgradedPriority) {
            existing.priority = priority;
          }
          if (input.suggestedSkill && (upgradedPriority || !existing.suggestedSkill)) {
            existing.suggestedSkill = input.suggestedSkill;
          }
          if (input.sourceCategory && !existing.sourceCategory) {
            existing.sourceCategory = input.sourceCategory;
          }
        }
        const position = q.findIndex((entry) => entry.id === existing.id);
        return {
          outcome: 'enqueued',
          entry: { ...existing },
          queuePosition: position >= 0 ? position + 1 : undefined,
          deduped: true,
        };
      }
    }

    // F175: capacity check — only user messages are depth-limited
    if (input.from.kind === 'user') {
      const userQueuedCount = q.filter((e) => e.status === 'queued' && e.from.kind === 'user').length;
      if (userQueuedCount >= MAX_QUEUE_DEPTH) {
        return { outcome: 'full' };
      }
    }

    const entry: QueueEntry = {
      id: randomUUID(),
      threadId: input.threadId,
      userId: input.userId,
      kind: input.kind,
      ownerAuthProvenance,
      idempotencyKey: input.idempotencyKey,
      content: input.content,
      messageId: input.messageId ?? null,
      mergedMessageIds: [],
      from: structuredClone(input.from),
      targetCats: [...input.targetCats],
      allTargetCats: [...input.targetCats],
      ...(input.routingWarnings?.length ? { routingWarnings: structuredClone(input.routingWarnings) } : {}),
      ...(input.authorIntentByCatId ? { authorIntentByCatId: structuredClone(input.authorIntentByCatId) } : {}),
      intent: input.intent,
      status: 'queued',
      createdAt: this.nextEnqueuedAt(),
      autoExecute: input.autoExecute ?? false,
      queueCustodyAdmissionId: input.queueCustodyAdmissionId,
      a2aParentInvocationId: input.a2aParentInvocationId,
      priority,
      sourceCategory: input.sourceCategory,
      continuationKey: input.continuationKey,
      freshnessClosureId: input.freshnessClosureId,
      freshnessRequiredFrontierMessageId: input.freshnessRequiredFrontierMessageId,
      freshnessSupplementId: input.freshnessSupplementId,
      freshnessSupplementLineageId: input.freshnessSupplementLineageId,
      freshnessSupplementSeq: input.freshnessSupplementSeq,
      readOnlyToolPolicy: input.readOnlyToolPolicy,
      actionSuccessorFence: input.actionSuccessorFence,
      waitContinuationCarrier: input.waitContinuationCarrier,
      suggestedSkill: input.suggestedSkill,
      callerTraceContext: input.callerTraceContext,
      a2aTriggerMessageId: input.a2aTriggerMessageId,
      position: undefined,
    };
    q.push(entry);
    this.originalContents.set(entry.id, input.content);
    return { outcome: 'enqueued', entry: { ...entry }, queuePosition: q.length };
  }

  /** Check if any entry in the thread already carries this messageId (connector retry dedup). */
  hasEntryWithMessageId(threadId: string, messageId: string): boolean {
    return this.findEntryWithMessageId(threadId, messageId) !== null;
  }

  /** Return the exact Queue carrier for a persisted message across user scopes. */
  findEntryWithMessageId(threadId: string, messageId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find((e) => e.messageId === messageId || e.mergedMessageIds?.includes(messageId));
      if (entry) return { ...entry };
    }
    return null;
  }

  /** Backfill messageId on a new entry (null → value). */
  backfillMessageId(threadId: string, userId: string, entryId: string, messageId: string): void {
    const e = this.findEntry(threadId, userId, entryId);
    if (!e) return;
    if (e.kind === 'private_input') {
      throw new Error('private_input cannot reference a public History message');
    }
    if (!e.messageId) {
      e.messageId = messageId;
      return;
    }
    if (e.messageId !== messageId && !e.mergedMessageIds.includes(messageId)) {
      e.mergedMessageIds.push(messageId);
    }
  }

  /** Rollback an enqueued entry — remove entirely. */
  rollbackEnqueue(threadId: string, userId: string, entryId: string): void {
    this.remove(threadId, userId, entryId);
    this.originalContents.delete(entryId);
  }

  /**
   * Publish every carrier in one custody admission after its full durable CAS.
   * Validation is complete before the first mutation, so ordinary selectors see
   * either the fenced group or the committed group, never a partially released set.
   * A duplicate recovery may observe the whole group already committed; that exact
   * all-unfenced state is an idempotent success, while mixed/foreign fences fail.
   */
  commitQueueCustodyAdmission(
    threadId: string,
    userId: string,
    admissionId: string,
    entryIds: readonly string[],
  ): boolean {
    const distinctEntryIds = [...new Set(entryIds)];
    if (!admissionId || distinctEntryIds.length !== entryIds.length) return false;
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return false;
    const byId = new Map(q.map((entry) => [entry.id, entry]));
    const entries = distinctEntryIds.map((entryId) => byId.get(entryId));
    if (entries.some((entry) => !entry || entry.status !== 'queued')) {
      return false;
    }
    const alreadyCommitted = entries.every((entry) => entry?.queueCustodyAdmissionId === undefined);
    const ownsAdmission = entries.every((entry) => entry?.queueCustodyAdmissionId === admissionId);
    if (!alreadyCommitted && !ownsAdmission) return false;
    for (const entry of entries as QueueEntry[]) delete entry.queueCustodyAdmissionId;
    return true;
  }

  /** Remove and return the first entry (FIFO). */
  dequeue(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q || q.length === 0) return null;
    return q.shift()!;
  }

  /** Look at the first entry without removing. */
  peek(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    return q?.[0] ?? null;
  }

  /** Remove a specific entry by id. Returns null if not found. */
  remove(threadId: string, userId: string, entryId: string): QueueEntry | null {
    let q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    let idx = q.findIndex((e) => e.id === entryId);
    if (idx === -1) return null;
    const batch = q[idx]?.exactSteerBatch;
    if (batch) {
      this.releaseExactUserBatch(threadId, userId, batch.reservationId);
      q = this.queues.get(this.scopeKey(threadId, userId));
      if (!q) return null;
      idx = q.findIndex((entry) => entry.id === entryId);
      if (idx === -1) return null;
    }
    this.originalContents.delete(entryId);

    return q.splice(idx, 1)[0] ?? null;
  }

  /** Retire every process-local carrier for one persisted action fence. */
  retireActionSuccessorFence(fence: ActionSuccessorFence): ActionSuccessorQueueRetirement[] {
    const retired: ActionSuccessorQueueRetirement[] = [];
    for (const [scope, queue] of this.queues) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const entry = queue[index];
        if (!entry || !actionSuccessorFencesMatch(entry.actionSuccessorFence, fence)) continue;
        queue.splice(index, 1);
        this.originalContents.delete(entry.id);
        retired.push({
          entryId: entry.id,
          threadId: entry.threadId,
          userId: entry.userId,
          messageIds: exactA2ASourceMessageIds(entry),
        });
      }
      if (queue.length === 0) this.queues.delete(scope);
    }
    return retired;
  }

  /** Read the exact process carriers before durable custody retirement. */
  listActionSuccessorFence(fence: ActionSuccessorFence): ActionSuccessorQueueRetirement[] {
    const matches: ActionSuccessorQueueRetirement[] = [];
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        if (!actionSuccessorFencesMatch(entry.actionSuccessorFence, fence)) continue;
        matches.push({
          entryId: entry.id,
          threadId: entry.threadId,
          userId: entry.userId,
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
    return [...q].sort(InvocationQueue.compareEntries);
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
  claimExactAppend(
    threadId: string,
    userId: string,
    entryId: string,
    expectedQueueRevision: string,
    expectedTargetIds: readonly string[],
  ): QueueEntry | null {
    if (this.snapshotRevision(threadId, userId) !== expectedQueueRevision) return null;
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      entry.kind === 'private_input' ||
      entry.exactSteerBatch ||
      entry.queueCustodyAdmissionId ||
      isSystemPinnedQueueEntry(entry) ||
      expectedTargetIds.length === 0 ||
      expectedTargetIds.length !== entry.targetCats.length ||
      expectedTargetIds.some((targetId, index) => targetId !== entry.targetCats[index]) ||
      expectedTargetIds.some((targetId) => !isOrdinaryQueueTargetEligible(entry, targetId))
    ) {
      return null;
    }
    entry.status = 'processing';
    entry.processingStartedAt = Date.now();
    return InvocationQueue.cloneEntry(entry);
  }

  /** Persist the exact Active Run body exposure before the Queue row is detached. */
  recordLifecycleAppendExposure(
    threadId: string,
    userId: string,
    entryId: string,
    runs: readonly { targetId: string; invocationId: string }[],
    seenAt: number,
  ): QueueEntry | null {
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'processing' ||
      runs.length !== entry.targetCats.length ||
      runs.some((run, index) => run.targetId !== entry.targetCats[index] || !run.invocationId)
    ) {
      return null;
    }
    const exposures = [...(entry.queuedBodyExposures ?? [])];
    const seen = new Set(entry.queuedSeenByCatIds ?? []);
    const seenInvocationIdByCatId = { ...(entry.queuedSeenInvocationIdByCatId ?? {}) };
    for (const run of runs) {
      const existing = exposures.find(
        (candidate) => candidate.targetCatId === run.targetId && candidate.invocationId === run.invocationId,
      );
      if (existing && existing.seenAt !== seenAt) return null;
      if (!existing) exposures.push({ targetCatId: run.targetId, invocationId: run.invocationId, seenAt });
      seen.add(run.targetId);
      seenInvocationIdByCatId[run.targetId] = run.invocationId;
    }
    entry.queuedBodyExposures = exposures;
    entry.queuedSeenByCatIds = [...seen];
    entry.queuedSeenInvocationIdByCatId = seenInvocationIdByCatId;
    return InvocationQueue.cloneEntry(entry);
  }

  /** Stable deep snapshot for persistence/rollback boundaries. */
  getEntrySnapshot(threadId: string, userId: string, entryId: string): QueueEntry | null {
    const entry = this.findEntry(threadId, userId, entryId);
    return entry ? InvocationQueue.cloneEntry(entry) : null;
  }

  /** Resolve a durable carrier by its globally unique entry id without trusting a source-thread projection. */
  getEntrySnapshotForUserById(userId: string, entryId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      const entry = q.find((candidate) => candidate.id === entryId && candidate.userId === userId);
      if (entry) return InvocationQueue.cloneEntry(entry);
    }
    return null;
  }

  /**
   * Restore a pre-mutation snapshot only while the exact post-mutation state is
   * still current. This CAS boundary prevents a failed durable side effect from
   * rolling back a later concurrent Queue update.
   */
  restoreEntrySnapshotIfUnchanged(expectedCurrent: QueueEntry, replacement: QueueEntry): boolean {
    if (
      expectedCurrent.id !== replacement.id ||
      expectedCurrent.threadId !== replacement.threadId ||
      expectedCurrent.userId !== replacement.userId
    ) {
      throw new Error('Queue snapshot restore identity mismatch');
    }
    const q = this.queues.get(this.scopeKey(expectedCurrent.threadId, expectedCurrent.userId));
    const index = q?.findIndex((entry) => entry.id === expectedCurrent.id) ?? -1;
    if (!q || index < 0) return false;
    const current = q[index];
    if (JSON.stringify(current) !== JSON.stringify(expectedCurrent)) return false;
    q[index] = InvocationQueue.cloneEntry(replacement);
    return true;
  }

  /** Remove one exact Queue snapshot while it is still current. */
  removeEntrySnapshotIfUnchanged(expectedCurrent: QueueEntry): boolean {
    const q = this.queues.get(this.scopeKey(expectedCurrent.threadId, expectedCurrent.userId));
    const index = q?.findIndex((entry) => entry.id === expectedCurrent.id) ?? -1;
    if (!q || index < 0) return false;
    const current = q[index];
    if (JSON.stringify(current) !== JSON.stringify(expectedCurrent)) return false;
    q.splice(index, 1);
    this.originalContents.delete(expectedCurrent.id);
    return true;
  }

  /** Restore one exact TTL-0 Queue owner after process restart or failed persistence. Idempotent by entryId. */
  restoreDurableEntry(entry: QueueEntry, options?: { beforeEntryId?: string }): 'restored' | 'existing' {
    InvocationQueue.requireAdmissionContract(entry);
    this.lastEnqueuedAt = Math.max(this.lastEnqueuedAt, entry.createdAt);
    for (const q of this.queues.values()) {
      const existing = q.find((candidate) => candidate.id === entry.id);
      if (!existing) continue;
      if (existing.threadId !== entry.threadId || existing.userId !== entry.userId) {
        throw new Error(`durable Queue entry identity collision: ${entry.id}`);
      }
      return 'existing';
    }
    const restored = InvocationQueue.cloneEntry(entry);
    const queue = this.getOrCreate(this.scopeKey(entry.threadId, entry.userId));
    const beforeIndex = options?.beforeEntryId
      ? queue.findIndex((candidate) => candidate.id === options.beforeEntryId)
      : -1;
    queue.splice(beforeIndex >= 0 ? beforeIndex : queue.length, 0, restored);
    this.originalContents.set(entry.id, entry.content);
    return 'restored';
  }

  /** F254 D1.1: queued freshness input scoped to the cat that would process it. */
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
    mergedMessageIds?: string[];
    sourceCategory?: QueueEntry['sourceCategory'];
  }> {
    return this.list(threadId, userId)
      .filter((entry) => entry.id !== opts?.excludeEntryId)
      .filter((entry) => entry.status === 'queued' && entry.targetCats.includes(catId))
      .filter((entry) => InvocationQueue.canExposeToCurrentParent(entry, catId, opts?.parentInvocationId))
      .filter((entry) => !entry.queuedSeenByCatIds?.includes(catId))
      .map((entry) => ({
        entryId: entry.id,
        from: structuredClone(entry.from),
        content: entry.content,
        ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
        ...(entry.mergedMessageIds.length > 0 ? { mergedMessageIds: [...entry.mergedMessageIds] } : {}),
        ...(entry.sourceCategory ? { sourceCategory: entry.sourceCategory } : {}),
      }));
  }

  /** F254 D1.2a: queued bodies readable by a target cat. Seen suppresses nags, not body access. */
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
    mergedMessageIds?: string[];
  }> {
    return this.list(threadId, userId)
      .filter((entry) => entry.status === 'queued' && entry.targetCats.includes(catId))
      .filter((entry) => InvocationQueue.canExposeToCurrentParent(entry, catId, parentInvocationId))
      .map((entry) => ({
        entryId: entry.id,
        from: structuredClone(entry.from),
        content: entry.content,
        ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
        ...(entry.mergedMessageIds.length > 0 ? { mergedMessageIds: [...entry.mergedMessageIds] } : {}),
      }));
  }

  private static canExposeToCurrentParent(
    entry: Pick<QueueEntry, 'from' | 'authorIntentByCatId'>,
    catId: string,
    parentInvocationId: string | undefined,
  ): boolean {
    // Author disposition belongs only to human-authored work. Agent and connector
    // carriers retain their typed custody/continuation path and may be read at a
    // current safe boundary without manufacturing a human queue preference.
    if (entry.from.kind !== 'user') return true;
    const authorIntent = entry.authorIntentByCatId?.[catId];
    return Boolean(
      parentInvocationId &&
        authorIntent?.requested === 'continue_current' &&
        authorIntent.fallbackAt === undefined &&
        authorIntent.boundParentInvocationId === parentInvocationId,
    );
  }

  /**
   * Close every still-pending exposure window bound to one terminal parent.
   * The immutable request/fence remain; only an append-only fallback fact is added.
   */
  fallbackAuthorIntentsForParentAcrossUsers(
    threadId: string,
    catId: string,
    parentInvocationId: string,
    fallbackAt = Date.now(),
  ): Array<{ entryId: string; userId: string }> {
    const changed: Array<{ entryId: string; userId: string }> = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const entry of q) {
        if (entry.status !== 'queued' || !entry.targetCats.includes(catId)) continue;
        const authorIntent = entry.authorIntentByCatId?.[catId];
        if (
          authorIntent?.requested !== 'continue_current' ||
          authorIntent.boundParentInvocationId !== parentInvocationId ||
          authorIntent.fallbackAt !== undefined
        ) {
          continue;
        }
        const hadExposure = (entry.queuedBodyExposures ?? []).some((exposure) => exposure.targetCatId === catId);
        entry.authorIntentByCatId = {
          ...(entry.authorIntentByCatId ?? {}),
          [catId]: {
            ...authorIntent,
            fallbackAt,
            fallbackReason: hadExposure ? 'parent_non_success_after_exposure' : 'parent_terminal_before_exposure',
          },
        };
        changed.push({ entryId: entry.id, userId: entry.userId });
      }
    }
    return changed;
  }

  /** Record that a best-effort freshness notice reached this target's current invocation. */
  markQueuedNotified(threadId: string, userId: string, entryId: string, catId: string): boolean {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry || entry.status !== 'queued' || !isOrdinaryQueueTargetEligible(entry, catId)) return false;
    if (entry.queuedSeenByCatIds?.includes(catId)) return false;
    const notified = new Set(entry.queuedNotifiedByCatIds ?? []);
    const alreadyNotified = notified.has(catId);
    notified.add(catId);
    entry.queuedNotifiedByCatIds = [...notified];
    return !alreadyNotified;
  }

  markSteering(threadId: string, userId: string, entryId: string, catId: string): boolean {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry || entry.status !== 'queued' || !isOrdinaryQueueTargetEligible(entry, catId)) return false;
    const requested = new Set(entry.steerRequestedByCatIds ?? []);
    const changed = !requested.has(catId);
    requested.add(catId);
    entry.steerRequestedByCatIds = [...requested];
    return changed;
  }

  clearSteering(threadId: string, userId: string, entryId: string, catId: string): boolean {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry) return false;
    const hadRequested = entry.steerRequestedByCatIds?.includes(catId) ?? false;
    const hadInvocation = !!entry.steeredInvocationIdByCatId?.[catId];
    entry.steerRequestedByCatIds = entry.steerRequestedByCatIds?.filter((candidate) => candidate !== catId);
    if (entry.steerRequestedByCatIds?.length === 0) entry.steerRequestedByCatIds = undefined;
    if (entry.steeredInvocationIdByCatId) {
      delete entry.steeredInvocationIdByCatId[catId];
      if (Object.keys(entry.steeredInvocationIdByCatId).length === 0) {
        entry.steeredInvocationIdByCatId = undefined;
      }
    }
    return hadRequested || hadInvocation;
  }

  /**
   * Bind the exact provider child as soon as it exists, before the queued body
   * is exposed. This preserves "woke" independently from "read".
   */
  markQueuedAwakened(
    threadId: string,
    userId: string,
    entryId: string,
    catId: string,
    invocationId: string,
    awakenedAt = Date.now(),
  ): boolean {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry || !isOrdinaryQueueTargetEligible(entry, catId)) return false;
    const existingInvocationId = entry.queuedAwakenedInvocationIdByCatId?.[catId];
    const existingAwakenedAt = entry.queuedAwakenedAtByCatId?.[catId];
    if (existingInvocationId === invocationId) {
      if (existingAwakenedAt !== undefined && existingAwakenedAt !== awakenedAt) {
        throw new Error('queued awakened timestamp is immutable');
      }
      return false;
    }
    entry.queuedAwakenedInvocationIdByCatId = {
      ...(entry.queuedAwakenedInvocationIdByCatId ?? {}),
      [catId]: invocationId,
    };
    entry.queuedAwakenedAtByCatId = {
      ...(entry.queuedAwakenedAtByCatId ?? {}),
      [catId]: awakenedAt,
    };
    entry.queuedNotifiedByCatIds = entry.queuedNotifiedByCatIds?.filter((candidate) => candidate !== catId);
    if (entry.queuedNotifiedByCatIds?.length === 0) entry.queuedNotifiedByCatIds = undefined;
    return true;
  }

  /**
   * F254 D1.2a: mark a queued entry as seen by one target cat.
   * Does not consume or deliver the entry.
   *
   * Returns whether this call created the first queued_seen state transition for
   * this cat. Invocation evidence is still refreshed on repeat reads so retry
   * attempts can close handled evidence without double-counting queued_seen.
   */
  markQueuedSeen(
    threadId: string,
    userId: string,
    entryId: string,
    catId: string,
    invocationId?: string,
    seenAt = Date.now(),
  ): boolean {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry || entry.status !== 'queued' || !isOrdinaryQueueTargetEligible(entry, catId)) return false;
    const seen = new Set(entry.queuedSeenByCatIds ?? []);
    const alreadySeen = seen.has(catId);
    seen.add(catId);
    entry.queuedSeenByCatIds = [...seen];
    entry.queuedNotifiedByCatIds = entry.queuedNotifiedByCatIds?.filter((candidate) => candidate !== catId);
    if (entry.queuedNotifiedByCatIds?.length === 0) entry.queuedNotifiedByCatIds = undefined;
    if (invocationId) {
      entry.queuedSeenInvocationIdByCatId = { ...(entry.queuedSeenInvocationIdByCatId ?? {}), [catId]: invocationId };
      if (
        !(entry.queuedBodyExposures ?? []).some(
          (exposure) => exposure.targetCatId === catId && exposure.invocationId === invocationId,
        )
      ) {
        entry.queuedBodyExposures = [
          ...(entry.queuedBodyExposures ?? []),
          { targetCatId: catId, invocationId, seenAt },
        ];
      }
    }
    return !alreadySeen;
  }

  /**
   * Record the exact Queue bodies supplied as the current invocation prompt.
   * Processing entries are no longer discoverable through get_thread_context,
   * so their read evidence must be bound at the provider launch boundary.
   */
  markProcessingSeen(
    threadId: string,
    userId: string,
    entryId: string,
    catIds: readonly string[],
    invocationId: string,
    seenAt = Date.now(),
  ): string[] {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry || entry.status !== 'processing') return [];
    const seen = new Set(entry.queuedSeenByCatIds ?? []);
    const notified = new Set(entry.queuedNotifiedByCatIds ?? []);
    const failed = new Set(entry.queuedFailedByCatIds ?? []);
    const marked: string[] = [];
    for (const catId of catIds) {
      if (!isOrdinaryQueueTargetEligible(entry, catId)) continue;
      seen.add(catId);
      notified.delete(catId);
      entry.queuedSeenInvocationIdByCatId = {
        ...(entry.queuedSeenInvocationIdByCatId ?? {}),
        [catId]: invocationId,
      };
      if (
        !(entry.queuedBodyExposures ?? []).some(
          (exposure) => exposure.targetCatId === catId && exposure.invocationId === invocationId,
        )
      ) {
        entry.queuedBodyExposures = [
          ...(entry.queuedBodyExposures ?? []),
          { targetCatId: catId, invocationId, seenAt },
        ];
      }
      if (entry.steerRequestedByCatIds?.includes(catId)) {
        entry.steerRequestedByCatIds = entry.steerRequestedByCatIds.filter((candidate) => candidate !== catId);
        if (entry.steerRequestedByCatIds.length === 0) entry.steerRequestedByCatIds = undefined;
        entry.steeredInvocationIdByCatId = {
          ...(entry.steeredInvocationIdByCatId ?? {}),
          [catId]: invocationId,
        };
      }
      marked.push(catId);
    }
    if (marked.length === 0) return [];
    entry.queuedSeenByCatIds = [...seen];
    entry.queuedNotifiedByCatIds = notified.size > 0 ? [...notified] : undefined;
    entry.queuedFailedByCatIds = failed.size > 0 ? [...failed] : undefined;
    return marked;
  }

  /** Bind the custody-CAS winner before its exact retry target can start. */
  bindRetryAttemptId(
    threadId: string,
    userId: string,
    entryId: string,
    catId: string,
    attemptId: string,
  ): QueueEntry | null {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry || entry.status !== 'queued' || !entry.targetCats.includes(catId) || !attemptId) return null;
    entry.queuedAttemptIdByCatId = { ...(entry.queuedAttemptIdByCatId ?? {}), [catId]: attemptId };
    return InvocationQueue.cloneEntry(entry);
  }

  /**
   * F254 D1.2b: retry reuses an InvocationRecord id, so clear stale handled-evidence tokens
   * before the retry attempt starts. The read marker remains: seen still suppresses nags.
   */
  clearQueuedSeenInvocationForCats(threadId: string, catIds: readonly string[], invocationId: string): number {
    const targetCats = new Set(catIds);
    let cleared = 0;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const entry of q) {
        if (
          !entry ||
          entry.status !== 'queued' ||
          (!entry.queuedSeenInvocationIdByCatId && !entry.queuedAwakenedInvocationIdByCatId)
        ) {
          continue;
        }
        for (const catId of targetCats) {
          const hadSeen = entry.queuedSeenInvocationIdByCatId?.[catId] === invocationId;
          const hadAwakened = entry.queuedAwakenedInvocationIdByCatId?.[catId] === invocationId;
          if (!hadSeen && !hadAwakened) continue;
          if (hadSeen && entry.queuedSeenInvocationIdByCatId) {
            delete entry.queuedSeenInvocationIdByCatId[catId];
          }
          if (hadAwakened && entry.queuedAwakenedInvocationIdByCatId) {
            delete entry.queuedAwakenedInvocationIdByCatId[catId];
            delete entry.queuedAwakenedAtByCatId?.[catId];
          }
          if (entry.steeredInvocationIdByCatId?.[catId] === invocationId) {
            delete entry.steeredInvocationIdByCatId[catId];
          }
          cleared += 1;
        }
        if (entry.queuedSeenInvocationIdByCatId && Object.keys(entry.queuedSeenInvocationIdByCatId).length === 0) {
          entry.queuedSeenInvocationIdByCatId = undefined;
        }
        if (
          entry.queuedAwakenedInvocationIdByCatId &&
          Object.keys(entry.queuedAwakenedInvocationIdByCatId).length === 0
        ) {
          entry.queuedAwakenedInvocationIdByCatId = undefined;
          entry.queuedAwakenedAtByCatId = undefined;
        }
        if (entry.steeredInvocationIdByCatId && Object.keys(entry.steeredInvocationIdByCatId).length === 0) {
          entry.steeredInvocationIdByCatId = undefined;
        }
      }
    }
    return cleared;
  }

  /** F254 D1.2b: consume only this cat's target for queued entries it already saw. */
  markQueuedHandledForCatAcrossUsers(threadId: string, catId: string, invocationId?: string): QueuedHandledResult[] {
    const handled: QueuedHandledResult[] = [];
    if (!invocationId) return handled;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (let i = 0; i < q.length; i++) {
        const entry = q[i];
        if (!entry || !InvocationQueue.isQueuedHandledCandidate(entry, catId, invocationId)) continue;

        const result = InvocationQueue.markQueuedHandledEntry(entry, catId, i, this.originalContents.get(entry.id));
        handled.push(result);

        if (result.fullyConsumed) {
          this.originalContents.delete(entry.id);
          q.splice(i, 1);
          i--;
        }
      }
    }
    return handled;
  }

  /**
   * Retire one failed target from its operational Queue carrier. The returned
   * snapshot is the pre-terminal custody witness; remaining siblings keep the
   * historical failure marker but the failed target is no longer selectable.
   */
  takeQueuedFailedTargetForCatAcrossUsers(
    threadId: string,
    catId: string,
    invocationId: string,
    attemptedEntryIds: ReadonlySet<string> = new Set(),
    terminalReason: QueueTargetAttemptTerminalReason = 'invocation_failed',
    failedAt = Date.now(),
  ): QueuedHandledResult[] {
    const failed: QueuedHandledResult[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (let i = 0; i < q.length; i++) {
        const entry = q[i];
        if (
          !entry ||
          entry.status !== 'queued' ||
          !entry.targetCats.includes(catId) ||
          (entry.queuedSeenInvocationIdByCatId?.[catId] !== invocationId && !attemptedEntryIds.has(entry.id))
        ) {
          continue;
        }

        const result = InvocationQueue.takeQueuedTargetEntry(entry, catId, i, this.originalContents.get(entry.id), {
          kind: 'failed',
          terminalReason,
          failedAt,
        });
        failed.push(result);

        if (result.fullyConsumed) {
          this.originalContents.delete(entry.id);
          q.splice(i, 1);
          i--;
        }
      }
    }
    return failed;
  }

  /**
   * Detect an attempted target that remained Queue-owned after a nominally
   * successful execution. This is the fail-closed guard for a child that
   * reached `done` without ever binding the exact prompt-body exposure.
   */
  hasAttemptedQueuedTargetAcrossUsers(
    threadId: string,
    catId: string,
    attemptedEntryIds: ReadonlySet<string>,
  ): boolean {
    if (attemptedEntryIds.size === 0) return false;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (
        q.some(
          (entry) => entry.status === 'queued' && attemptedEntryIds.has(entry.id) && entry.targetCats.includes(catId),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private static isQueuedHandledCandidate(entry: QueueEntry, catId: string, invocationId: string): boolean {
    return (
      entry.status === 'queued' &&
      entry.targetCats.includes(catId) &&
      entry.queuedSeenInvocationIdByCatId?.[catId] === invocationId
    );
  }

  restoreQueuedHandledResult(result: QueuedHandledResult): boolean {
    if (!result.entrySnapshot) return false;
    const key = this.scopeKey(result.threadId, result.userId);
    const q = this.getOrCreate(key);
    const restored = InvocationQueue.cloneEntry(result.entrySnapshot);
    const existingIndex = q.findIndex((entry) => entry.id === result.entryId);
    if (existingIndex >= 0) {
      q[existingIndex] = restored;
    } else {
      const index = Math.max(0, Math.min(result.queueIndex ?? q.length, q.length));
      q.splice(index, 0, restored);
    }
    this.originalContents.set(restored.id, result.originalContent ?? restored.content);
    return true;
  }

  private static markQueuedHandledEntry(
    entry: QueueEntry,
    catId: string,
    queueIndex: number,
    originalContent?: string,
  ): QueuedHandledResult {
    return InvocationQueue.takeQueuedTargetEntry(entry, catId, queueIndex, originalContent, { kind: 'handled' });
  }

  private static takeQueuedTargetEntry(
    entry: QueueEntry,
    catId: string,
    queueIndex: number,
    originalContent: string | undefined,
    disposition:
      | { kind: 'handled' }
      | {
          kind: 'failed';
          terminalReason: QueueTargetAttemptTerminalReason;
          failedAt: number;
        },
  ): QueuedHandledResult {
    const entrySnapshot = InvocationQueue.cloneEntry(entry);
    const remainingTargetCats = entry.targetCats.filter((targetCat) => targetCat !== catId);
    entry.targetCats = remainingTargetCats;
    if (disposition.kind === 'handled') {
      const handledCats = new Set(entry.queuedHandledByCatIds ?? []);
      handledCats.add(catId);
      entry.queuedHandledByCatIds = [...handledCats];
      entry.queuedFailedByCatIds = entry.queuedFailedByCatIds?.filter((candidate) => candidate !== catId);
      if (entry.queuedFailureAtByCatId) {
        delete entry.queuedFailureAtByCatId[catId];
        if (Object.keys(entry.queuedFailureAtByCatId).length === 0) entry.queuedFailureAtByCatId = undefined;
      }
      if (entry.queuedFailureReasonByCatId) {
        delete entry.queuedFailureReasonByCatId[catId];
        if (Object.keys(entry.queuedFailureReasonByCatId).length === 0) entry.queuedFailureReasonByCatId = undefined;
      }
    } else {
      const failedCats = new Set(entry.queuedFailedByCatIds ?? []);
      failedCats.add(catId);
      entry.queuedFailedByCatIds = [...failedCats];
      entry.queuedFailureAtByCatId = {
        ...(entry.queuedFailureAtByCatId ?? {}),
        [catId]: disposition.failedAt,
      };
      entry.queuedFailureReasonByCatId = {
        ...(entry.queuedFailureReasonByCatId ?? {}),
        [catId]: disposition.terminalReason,
      };
    }
    entry.queuedNotifiedByCatIds = entry.queuedNotifiedByCatIds?.filter((candidate) => candidate !== catId);
    entry.steerRequestedByCatIds = entry.steerRequestedByCatIds?.filter((candidate) => candidate !== catId);
    if (entry.steerRequestedByCatIds?.length === 0) entry.steerRequestedByCatIds = undefined;
    if (entry.steeredInvocationIdByCatId) {
      delete entry.steeredInvocationIdByCatId[catId];
      if (Object.keys(entry.steeredInvocationIdByCatId).length === 0) entry.steeredInvocationIdByCatId = undefined;
    }
    if (entry.queuedSeenInvocationIdByCatId) {
      delete entry.queuedSeenInvocationIdByCatId[catId];
      if (Object.keys(entry.queuedSeenInvocationIdByCatId).length === 0) {
        entry.queuedSeenInvocationIdByCatId = undefined;
      }
    }
    if (entry.queuedAwakenedInvocationIdByCatId) {
      delete entry.queuedAwakenedInvocationIdByCatId[catId];
      delete entry.queuedAwakenedAtByCatId?.[catId];
      if (Object.keys(entry.queuedAwakenedInvocationIdByCatId).length === 0) {
        entry.queuedAwakenedInvocationIdByCatId = undefined;
        entry.queuedAwakenedAtByCatId = undefined;
      }
    }
    if (entry.queuedAttemptIdByCatId) {
      delete entry.queuedAttemptIdByCatId[catId];
      if (Object.keys(entry.queuedAttemptIdByCatId).length === 0) entry.queuedAttemptIdByCatId = undefined;
    }
    const messageIds = [entry.messageId ?? '', ...entry.mergedMessageIds].filter(Boolean);
    return {
      entryId: entry.id,
      threadId: entry.threadId,
      userId: entry.userId,
      catId,
      messageIds,
      remainingTargetCats: [...remainingTargetCats],
      fullyConsumed: remainingTargetCats.length === 0,
      entrySnapshot,
      queueIndex,
      originalContent,
    };
  }

  private static cloneEntry(entry: QueueEntry): QueueEntry {
    return {
      ...entry,
      from: structuredClone(entry.from),
      targetCats: [...entry.targetCats],
      ...(entry.allTargetCats ? { allTargetCats: [...entry.allTargetCats] } : {}),
      ...(entry.authorIntentByCatId ? { authorIntentByCatId: structuredClone(entry.authorIntentByCatId) } : {}),
      ...(entry.queuedNotifiedByCatIds ? { queuedNotifiedByCatIds: [...entry.queuedNotifiedByCatIds] } : {}),
      ...(entry.queuedAwakenedInvocationIdByCatId
        ? { queuedAwakenedInvocationIdByCatId: { ...entry.queuedAwakenedInvocationIdByCatId } }
        : {}),
      ...(entry.queuedAwakenedAtByCatId ? { queuedAwakenedAtByCatId: { ...entry.queuedAwakenedAtByCatId } } : {}),
      mergedMessageIds: [...entry.mergedMessageIds],
      ...(entry.queuedSeenByCatIds ? { queuedSeenByCatIds: [...entry.queuedSeenByCatIds] } : {}),
      ...(entry.queuedSeenInvocationIdByCatId
        ? { queuedSeenInvocationIdByCatId: { ...entry.queuedSeenInvocationIdByCatId } }
        : {}),
      ...(entry.queuedBodyExposures
        ? { queuedBodyExposures: entry.queuedBodyExposures.map((exposure) => ({ ...exposure })) }
        : {}),
      ...(entry.queuedFailedByCatIds ? { queuedFailedByCatIds: [...entry.queuedFailedByCatIds] } : {}),
      ...(entry.queuedFailureAtByCatId ? { queuedFailureAtByCatId: { ...entry.queuedFailureAtByCatId } } : {}),
      ...(entry.queuedFailureReasonByCatId
        ? { queuedFailureReasonByCatId: { ...entry.queuedFailureReasonByCatId } }
        : {}),
      ...(entry.queuedAttemptIdByCatId ? { queuedAttemptIdByCatId: { ...entry.queuedAttemptIdByCatId } } : {}),
      ...(entry.queuedHandledByCatIds ? { queuedHandledByCatIds: [...entry.queuedHandledByCatIds] } : {}),
      ...(entry.steerRequestedByCatIds ? { steerRequestedByCatIds: [...entry.steerRequestedByCatIds] } : {}),
      ...(entry.steeredInvocationIdByCatId
        ? { steeredInvocationIdByCatId: { ...entry.steeredInvocationIdByCatId } }
        : {}),
      ...(entry.exactSteerBatch
        ? {
            exactSteerBatch: {
              ...entry.exactSteerBatch,
              entryIds: [...entry.exactSteerBatch.entryIds],
            },
          }
        : {}),
      ...(entry.prestartRetirement
        ? {
            prestartRetirement: {
              ...entry.prestartRetirement,
              entryIds: [...entry.prestartRetirement.entryIds],
            },
          }
        : {}),
      ...(entry.callerTraceContext ? { callerTraceContext: { ...entry.callerTraceContext } } : {}),
    };
  }

  /** Count of queued (not processing) entries. */
  size(threadId: string, userId: string): number {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return 0;
    return q.filter((e) => e.status === 'queued').length;
  }

  /** Clear all entries for this user. Returns removed entries. */
  clear(threadId: string, userId: string): QueueEntry[] {
    const key = this.scopeKey(threadId, userId);
    const q = this.queues.get(key);
    if (!q) return [];
    for (const e of q) {
      this.originalContents.delete(e.id);
      if (e.exactSteerBatch) this.exactSteerReservations.delete(e.exactSteerBatch.reservationId);
    }
    this.queues.delete(key);
    return q;
  }

  /**
   * Move entry up or down in comparator order by swapping positions with its neighbor.
   * Returns false if entry is processing or not found.
   */
  move(threadId: string, userId: string, entryId: string, direction: 'up' | 'down'): boolean {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return false;
    const target = q.find((e) => e.id === entryId);
    if (!target || target.status === 'processing') return false;
    if (target.exactSteerBatch) return false;
    if (isSystemPinnedQueueEntry(target)) return false;

    const queued = q.filter((e) => e.status === 'queued');
    queued.sort(InvocationQueue.compareEntries);
    const sortedIdx = queued.findIndex((e) => e.id === entryId);
    const neighborIdx = direction === 'up' ? sortedIdx - 1 : sortedIdx + 1;
    if (neighborIdx < 0 || neighborIdx >= queued.length) return true;

    for (let i = 0; i < queued.length; i++) {
      queued[i]!.position = i;
    }
    const a = queued[sortedIdx]!;
    const b = queued[neighborIdx]!;
    const tmp = a.position!;
    a.position = b.position!;
    b.position = tmp;
    return true;
  }

  /**
   * Promote a queued entry to first in comparator order by setting its position
   * below all existing positions.
   * Returns false if not found or entry is processing.
   */
  promote(threadId: string, userId: string, entryId: string): boolean {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return false;
    const entry = q.find((e) => e.id === entryId);
    if (!entry || entry.status === 'processing') return false;
    if (entry.exactSteerBatch) return false;
    if (isSystemPinnedQueueEntry(entry)) return false;

    const minPos = q.reduce((min, e) => {
      if (e.status === 'queued' && e.position !== undefined && e.position < min) return e.position;
      return min;
    }, 0);
    entry.position = minPos - 1;
    return true;
  }

  /**
   * Atomically reserve an explicit ordinary-user allowlist before Steer preempts
   * the current invocation. Every validation happens before the first mutation.
   */
  reserveExactUserBatch(
    threadId: string,
    userId: string,
    entryIds: readonly string[],
  ): ExactUserBatchReservationResult {
    const distinctIds = [...new Set(entryIds)];
    if (distinctIds.length < 2 || distinctIds.length !== entryIds.length || distinctIds.length > MAX_QUEUE_DEPTH) {
      return { outcome: 'rejected', reason: 'invalid_entry_ids' };
    }

    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return { outcome: 'rejected', reason: 'entry_not_found' };
    const byId = new Map(q.map((entry) => [entry.id, entry]));
    const selected = distinctIds.map((entryId) => byId.get(entryId));
    if (selected.some((entry) => !entry)) return { outcome: 'rejected', reason: 'entry_not_found' };
    const entries = selected as QueueEntry[];

    if (entries.some((entry) => !InvocationQueue.isExactUserBatchEligible(entry))) {
      return { outcome: 'rejected', reason: 'entry_ineligible' };
    }

    const primary = entries[0];
    const targetCatId = primary?.targetCats[0];
    if (!primary || !targetCatId) return { outcome: 'rejected', reason: 'entry_ineligible' };
    if (
      entries.some(
        (entry) =>
          entry.intent !== primary.intent ||
          entry.ownerAuthProvenance !== primary.ownerAuthProvenance ||
          entry.targetCats[0] !== targetCatId,
      )
    ) {
      return { outcome: 'rejected', reason: 'entries_incompatible' };
    }

    return { outcome: 'reserved', ...this.commitExactSteerReservation(threadId, userId, entries, targetCatId) };
  }

  /**
   * Reserve one exact queued entry before single-message Steer crosses an await.
   * The durable steer marker records intent; this process-local identity is the
   * exclusive dequeue fence and cannot be claimed through ordinary queue APIs.
   */
  reserveExactUserEntry(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
  ): ExactUserEntryReservationResult {
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      !isOrdinaryQueueTargetEligible(entry, targetCatId) ||
      entry.exactSteerBatch ||
      entry.steerRequestedByCatIds?.includes(targetCatId) ||
      isSystemPinnedQueueEntry(entry)
    ) {
      return { outcome: 'rejected', reason: 'state_changed' };
    }
    return {
      outcome: 'reserved',
      ...this.commitExactSteerReservation(threadId, userId, [entry], targetCatId),
    };
  }

  private commitExactSteerReservation(
    threadId: string,
    userId: string,
    entries: readonly QueueEntry[],
    targetCatId: string,
  ): ExactSteerBatchReservation {
    const primary = entries[0]!;
    const entryIds = entries.map((entry) => entry.id);

    const reservation: ExactSteerBatchReservation = {
      reservationId: randomUUID(),
      primaryEntryId: primary.id,
      entryIds,
      targetCatId,
    };
    const snapshots = new Map(entries.map((entry) => [entry.id, InvocationQueue.cloneEntry(entry)]));

    const q = this.queues.get(this.scopeKey(threadId, userId))!;

    const minPos = q.reduce((min, entry) => {
      if (entry.status === 'queued' && entry.position !== undefined && entry.position < min) return entry.position;
      return min;
    }, 0);
    for (const entry of entries) {
      entry.exactSteerBatch = { ...reservation, entryIds: [...reservation.entryIds] };
      const requested = new Set(entry.steerRequestedByCatIds ?? []);
      requested.add(targetCatId);
      entry.steerRequestedByCatIds = [...requested];
    }
    primary.position = minPos - 1;
    this.exactSteerReservations.set(reservation.reservationId, {
      threadId,
      userId,
      primaryEntryId: primary.id,
      targetCatId,
      entries: snapshots,
      phase: 'reserved',
    });
    return reservation;
  }

  /** Cross the durable boundary immediately before preemption gains side effects. */
  beginExactSteerPreemption(threadId: string, userId: string, reservationId: string): boolean {
    const reservation = this.exactSteerReservations.get(reservationId);
    if (
      !reservation ||
      reservation.phase !== 'reserved' ||
      reservation.threadId !== threadId ||
      reservation.userId !== userId
    ) {
      return false;
    }
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (
      !q ||
      [...reservation.entries.keys()].some((entryId) => {
        const entry = q.find((candidate) => candidate.id === entryId);
        return entry?.status !== 'queued' || entry.exactSteerBatch?.reservationId !== reservationId;
      })
    ) {
      return false;
    }
    reservation.phase = 'preempting';
    return true;
  }

  /** Make one successfully preempted reservation eligible for its exact owner claim. */
  activateExactSteerReservation(threadId: string, userId: string, reservationId: string): boolean {
    const reservation = this.exactSteerReservations.get(reservationId);
    if (
      !reservation ||
      reservation.phase !== 'preempting' ||
      reservation.threadId !== threadId ||
      reservation.userId !== userId
    ) {
      return false;
    }
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (
      !q ||
      [...reservation.entries.keys()].some((entryId) => {
        const entry = q.find((candidate) => candidate.id === entryId);
        return entry?.status !== 'queued' || entry.exactSteerBatch?.reservationId !== reservationId;
      })
    ) {
      return false;
    }
    reservation.phase = 'activated';
    return true;
  }

  /** A reserved/preempting entry still has an in-flight route and cannot be withdrawn safely. */
  hasUnsettledExactSteerReservation(threadId: string, userId: string, entryId?: string): boolean {
    return [...this.exactSteerReservations.values()].some(
      (reservation) =>
        reservation.threadId === threadId &&
        reservation.userId === userId &&
        reservation.phase !== 'activated' &&
        (entryId === undefined || reservation.entries.has(entryId)),
    );
  }

  /** Peek a preempted exact reservation without granting ordinary dequeue its identity. */
  peekActivatedExactSteerReservation(
    threadId: string,
    userId?: string,
    onlyTargetCat?: string,
  ): ActivatedExactSteerReservation | null {
    let best: ActivatedExactSteerReservation | null = null;
    for (const [reservationId, reservation] of this.exactSteerReservations) {
      if (reservation.phase !== 'activated' || reservation.threadId !== threadId) continue;
      if (userId !== undefined && reservation.userId !== userId) continue;
      if (onlyTargetCat !== undefined && reservation.targetCatId !== onlyTargetCat) continue;
      const queue = this.queues.get(this.scopeKey(threadId, reservation.userId));
      if (
        !queue ||
        [...reservation.entries.keys()].some((entryId) => {
          const entry = queue.find((candidate) => candidate.id === entryId);
          return entry?.status !== 'queued' || entry.exactSteerBatch?.reservationId !== reservationId;
        })
      ) {
        continue;
      }
      const current = queue.find((entry) => entry.id === reservation.primaryEntryId);
      if (!current || current.exactSteerBatch?.primaryEntryId !== current.id) {
        continue;
      }
      if (!best || InvocationQueue.compareEntries(current, best.entry) < 0) {
        best = { reservationId, entry: InvocationQueue.cloneEntry(current) };
      }
    }
    return best;
  }

  /** Atomically claim only the exact entry set owned by this activated identity. */
  claimExactSteerReservation(
    threadId: string,
    userId: string,
    entryId: string,
    reservationId: string,
  ): QueueEntry | null {
    const reservation = this.exactSteerReservations.get(reservationId);
    if (reservation?.phase !== 'activated' || reservation.threadId !== threadId || reservation.userId !== userId) {
      return null;
    }
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.exactSteerBatch?.reservationId !== reservationId ||
      entry.exactSteerBatch.primaryEntryId !== entryId
    ) {
      return null;
    }
    return this.markEntryProcessing(entry, reservationId);
  }

  /** Release an unstarted reservation and restore every selected entry snapshot. */
  releaseExactUserBatch(threadId: string, userId: string, reservationId: string): QueueEntry[] {
    const reservation = this.exactSteerReservations.get(reservationId);
    if (!reservation || reservation.threadId !== threadId || reservation.userId !== userId) return [];
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) {
      this.exactSteerReservations.delete(reservationId);
      return [];
    }

    const restored: QueueEntry[] = [];
    for (const [entryId, snapshot] of reservation.entries) {
      const index = q.findIndex(
        (entry) =>
          entry.id === entryId && entry.status === 'queued' && entry.exactSteerBatch?.reservationId === reservationId,
      );
      if (index === -1) continue;
      const restoredEntry = InvocationQueue.cloneEntry(snapshot);
      q[index] = restoredEntry;
      restored.push(InvocationQueue.cloneEntry(restoredEntry));
    }
    this.exactSteerReservations.delete(reservationId);
    return restored;
  }

  /** Cancel every still-queued Batch Steer reservation in one user scope. */
  releaseAllExactUserBatches(threadId: string, userId: string): QueueEntry[] {
    const reservationIds = new Set(
      this.list(threadId, userId).flatMap((entry) =>
        entry.exactSteerBatch ? [entry.exactSteerBatch.reservationId] : [],
      ),
    );
    return [...reservationIds].flatMap((reservationId) => this.releaseExactUserBatch(threadId, userId, reservationId));
  }

  /** Drop rollback bookkeeping once no live Queue entry references the reservation. */
  pruneExactUserBatchReservation(reservationId: string): boolean {
    const stillReferenced = [...this.queues.values()].some((q) =>
      q.some((entry) => entry.exactSteerBatch?.reservationId === reservationId),
    );
    if (stillReferenced) return false;
    return this.exactSteerReservations.delete(reservationId);
  }

  /** Exact already-processing members, in the caller-frozen order, excluding the primary. */
  collectExactSteerBatchMembers(entry: QueueEntry): QueueEntry[] | null {
    const batch = entry.exactSteerBatch;
    if (!batch || batch.primaryEntryId !== entry.id) return null;
    const reservation = this.exactSteerReservations.get(batch.reservationId);
    if (!reservation || reservation.threadId !== entry.threadId || reservation.userId !== entry.userId) return null;
    const q = this.queues.get(this.scopeKey(entry.threadId, entry.userId));
    if (!q) return null;
    const byId = new Map(q.map((candidate) => [candidate.id, candidate]));
    const members: QueueEntry[] = [];
    for (const entryId of batch.entryIds) {
      const current = byId.get(entryId);
      if (
        !current ||
        current.status !== 'processing' ||
        current.exactSteerBatch?.reservationId !== batch.reservationId
      ) {
        return null;
      }
      if (entryId !== batch.primaryEntryId) members.push(InvocationQueue.cloneEntry(current));
    }
    return members;
  }

  /** Restore every member after a start-reservation persistence failure. */
  rollbackExactSteerBatchProcessing(threadId: string, reservationId: string): QueueEntry[] {
    const reservation = this.exactSteerReservations.get(reservationId);
    if (!reservation || reservation.threadId !== threadId) return [];
    const q = this.queues.get(this.scopeKey(reservation.threadId, reservation.userId));
    if (!q) return [];
    const rolledBack: QueueEntry[] = [];
    for (const entryId of reservation.entries.keys()) {
      const entry = q.find(
        (candidate) =>
          candidate.id === entryId &&
          candidate.status === 'processing' &&
          candidate.exactSteerBatch?.reservationId === reservationId,
      );
      if (!entry) continue;
      entry.status = 'queued';
      delete entry.processingStartedAt;
      rolledBack.push(InvocationQueue.cloneEntry(entry));
    }
    return rolledBack;
  }

  private static isExactUserBatchEligible(entry: QueueEntry): boolean {
    const targetCatId = entry.targetCats[0];
    return (
      entry.status === 'queued' &&
      entry.from.kind === 'user' &&
      entry.ownerAuthProvenance !== 'unknown' &&
      entry.targetCats.length === 1 &&
      !!targetCatId &&
      !entry.autoExecute &&
      !entry.sourceCategory &&
      !entry.actionSuccessorFence &&
      !entry.waitContinuationCarrier &&
      !entry.freshnessClosureId &&
      !entry.freshnessSupplementId &&
      !entry.continuationKey &&
      !entry.a2aParentInvocationId &&
      !entry.a2aTriggerMessageId &&
      !entry.exactSteerBatch &&
      isOrdinaryQueueTargetEligible(entry, targetCatId) &&
      entry.authorIntentByCatId?.[targetCatId]?.requested !== 'continue_current'
    );
  }

  /** Mark a primary plus its frozen exact allowlist in one synchronous mutation. */
  private markEntryProcessing(
    entry: QueueEntry,
    exactReservationId?: string,
    selectedTargetCatId?: string,
  ): QueueEntry | null {
    const batch = entry.exactSteerBatch;
    const targetCatId =
      selectedTargetCatId ??
      batch?.targetCatId ??
      entry.targetCats.find((catId) => isOrdinaryQueueTargetEligible(entry, catId));
    if (!targetCatId || !isOrdinaryQueueTargetEligible(entry, targetCatId)) return null;
    if (!batch) {
      entry.status = 'processing';
      entry.processingStartedAt = Date.now();
      return InvocationQueue.cloneEntry(entry);
    }
    if (exactReservationId !== batch.reservationId) return null;
    if (batch.primaryEntryId !== entry.id) return null;
    const reservation = this.exactSteerReservations.get(batch.reservationId);
    if (
      reservation?.phase !== 'activated' ||
      reservation.threadId !== entry.threadId ||
      reservation.userId !== entry.userId
    ) {
      return null;
    }
    const q = this.queues.get(this.scopeKey(entry.threadId, entry.userId));
    if (!q) return null;
    const byId = new Map(q.map((candidate) => [candidate.id, candidate]));
    const selected = batch.entryIds.map((entryId) => byId.get(entryId));
    if (
      selected.some(
        (candidate) =>
          !candidate ||
          candidate.status !== 'queued' ||
          candidate.exactSteerBatch?.reservationId !== batch.reservationId,
      )
    ) {
      return null;
    }
    const processingStartedAt = Date.now();
    for (const candidate of selected as QueueEntry[]) {
      candidate.status = 'processing';
      candidate.processingStartedAt = processingStartedAt;
    }
    return InvocationQueue.cloneEntry(entry);
  }

  /** Mark this user scope's strict comparator head as processing. */
  markProcessing(
    threadId: string,
    userId: string,
    resolvedHead?: { readonly entryId: string; readonly targetCats: readonly string[] },
  ): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const queued = q.filter((entry) => entry.status === 'queued' && !entry.exactSteerBatch);
    if (queued.length === 0) return null;
    queued.sort(InvocationQueue.compareEntries);
    const best = queued[0]!;
    let selectedTargetCatId = best.targetCats.find((catId) => isOrdinaryQueueTargetEligible(best, catId));
    if (resolvedHead) {
      if (
        resolvedHead.entryId !== best.id ||
        resolvedHead.targetCats.length === 0 ||
        resolvedHead.targetCats.some((catId) => typeof catId !== 'string' || !catId) ||
        new Set(resolvedHead.targetCats).size !== resolvedHead.targetCats.length
      ) {
        return null;
      }
      best.targetCats = [...resolvedHead.targetCats];
      best.allTargetCats = [...resolvedHead.targetCats];
      selectedTargetCatId = best.targetCats[0];
    }
    if (!selectedTargetCatId || !isOrdinaryQueueTargetEligible(best, selectedTargetCatId)) return null;
    return this.markEntryProcessing(best, undefined, selectedTargetCatId);
  }

  /** Peek at this user scope's strict comparator head, including targetless public work. */
  peekNextQueued(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const queued = q.filter((entry) => entry.status === 'queued' && !entry.exactSteerBatch);
    if (queued.length === 0) return null;
    queued.sort(InvocationQueue.compareEntries);
    return { ...queued[0]! };
  }

  /** Rollback a processing entry back to queued (undo markProcessing/markProcessingAcrossUsers). */
  rollbackProcessing(threadId: string, entryId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find((e) => e.id === entryId && e.status === 'processing');
      if (entry) {
        entry.status = 'queued';
        delete entry.processingStartedAt;
        return true;
      }
    }
    return false;
  }

  /** Remove a processing entry for this user by entryId. */
  removeProcessed(threadId: string, userId: string, entryId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const idx = q.findIndex((e) => e.status === 'processing' && e.id === entryId);
    if (idx === -1) return null;
    this.originalContents.delete(entryId);

    return q.splice(idx, 1)[0] ?? null;
  }

  // ── Cross-user methods (system-level only) ──

  /** Find the strict comparator head across all users, including targetless public work. */
  peekOldestAcrossUsers(threadId: string): QueueEntry | null {
    let best: QueueEntry | null = null;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.status !== 'queued' || e.exactSteerBatch) continue;
        if (!best || InvocationQueue.compareEntries(e, best) < 0) {
          best = e;
        }
      }
    }
    return best ? { ...best } : null;
  }

  /** Mark the strict comparator head across users as processing. */
  markProcessingAcrossUsers(
    threadId: string,
    resolvedHead?: { readonly entryId: string; readonly targetCats: readonly string[] },
  ): QueueEntry | null {
    let best: QueueEntry | null = null;
    let bestTargetCatId: string | undefined;
    const candidates: QueueEntry[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.status !== 'queued' || e.exactSteerBatch) continue;
        candidates.push(e);
        if (!best || InvocationQueue.compareEntries(e, best) < 0) {
          best = e;
          bestTargetCatId = e.targetCats.find((catId) => isOrdinaryQueueTargetEligible(e, catId));
        }
      }
    }
    if (!best) return null;
    if (resolvedHead) {
      if (
        resolvedHead.entryId !== best.id ||
        resolvedHead.targetCats.length === 0 ||
        resolvedHead.targetCats.some((catId) => typeof catId !== 'string' || !catId) ||
        new Set(resolvedHead.targetCats).size !== resolvedHead.targetCats.length
      ) {
        return null;
      }
      best.targetCats = [...resolvedHead.targetCats];
      best.allTargetCats = [...resolvedHead.targetCats];
      bestTargetCatId = best.targetCats[0];
    }
    if (!bestTargetCatId || !isOrdinaryQueueTargetEligible(best, bestTargetCatId)) return null;
    return this.markEntryProcessing(best, undefined, bestTargetCatId);
  }

  /**
   * Fence the exact strict head for a kind-specific pre-admission terminal action.
   * Unlike ordinary admission this claim intentionally has no target slot: no
   * provider invocation is allowed to exist for this entry.
   */
  claimPreAdmissionFailureAcrossUsers(threadId: string, entryId: string): QueueEntry | null {
    let best: QueueEntry | null = null;
    for (const queue of this.queues.values()) {
      if (!this.queueMatchesThread(queue, threadId)) continue;
      for (const candidate of queue) {
        if (candidate.status !== 'queued' || candidate.exactSteerBatch) continue;
        if (!best || InvocationQueue.compareEntries(candidate, best) < 0) best = candidate;
      }
    }
    if (!best || best.id !== entryId) return null;
    best.status = 'processing';
    best.processingStartedAt = Date.now();
    return InvocationQueue.cloneEntry(best);
  }

  /** Remove a processing entry across all users for a thread by entryId. */
  removeProcessedAcrossUsers(threadId: string, entryId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const idx = q.findIndex((e) => e.status === 'processing' && e.id === entryId);
      if (idx !== -1) {
        this.originalContents.delete(entryId);

        return q.splice(idx, 1)[0] ?? null;
      }
    }
    return null;
  }

  private resolveProcessingGroupAcrossUsers(
    threadId: string,
    entryId: string,
  ): { queue: QueueEntry[]; members: Array<{ candidate: QueueEntry; index: number }>; reservationId?: string } | null {
    for (const queue of this.queues.values()) {
      if (!this.queueMatchesThread(queue, threadId)) continue;
      const entry = queue.find((candidate) => candidate.status === 'processing' && candidate.id === entryId);
      if (!entry) continue;
      const batch = entry.exactSteerBatch;
      if (!batch && entry.prestartRetirement) {
        const intent = entry.prestartRetirement;
        const members = queue
          .map((candidate, index) => ({ candidate, index }))
          .filter(
            ({ candidate }) =>
              candidate.status === 'processing' &&
              candidate.prestartRetirement?.id === intent.id &&
              intent.entryIds.includes(candidate.id),
          );
        if (members.length === 0) return null;
        if (
          members.some(
            ({ candidate }) =>
              candidate.threadId !== entry.threadId ||
              candidate.userId !== entry.userId ||
              JSON.stringify(candidate.prestartRetirement) !== JSON.stringify(intent),
          )
        ) {
          return null;
        }
        return { queue, members };
      }
      if (!batch) return { queue, members: [{ candidate: entry, index: queue.indexOf(entry) }] };

      const reservation = this.exactSteerReservations.get(batch.reservationId);
      if (
        !reservation ||
        reservation.threadId !== threadId ||
        reservation.userId !== entry.userId ||
        reservation.primaryEntryId !== batch.primaryEntryId ||
        reservation.entries.size !== batch.entryIds.length ||
        batch.entryIds.some((memberId) => !reservation.entries.has(memberId))
      ) {
        return null;
      }

      const byId = new Map(queue.map((candidate, index) => [candidate.id, { candidate, index }]));
      const members: Array<{ candidate: QueueEntry; index: number }> = [];
      for (const memberId of batch.entryIds) {
        const member = byId.get(memberId);
        if (
          !member ||
          member.candidate.status !== 'processing' ||
          member.candidate.exactSteerBatch?.reservationId !== batch.reservationId
        ) {
          return null;
        }
        members.push(member);
      }
      return { queue, members, reservationId: batch.reservationId };
    }
    return null;
  }

  /** Fail-closed preflight for synchronous external replacement of a processing group. */
  canRemoveProcessingGroupAcrossUsers(threadId: string, entryId: string): boolean {
    return this.resolveProcessingGroupAcrossUsers(threadId, entryId) !== null;
  }

  /** Snapshot a complete processing group without making it invisible. */
  getProcessingGroupAcrossUsers(threadId: string, entryId: string): QueueEntry[] | null {
    const group = this.resolveProcessingGroupAcrossUsers(threadId, entryId);
    if (!group) return null;
    return group.members.map((member) => InvocationQueue.cloneEntry(member.candidate));
  }

  /**
   * Atomically tombstone one processing carrier and every member of its exact
   * Steer reservation. Supersession paths use this instead of treating the
   * primary row as the whole reservation. Ordinary attempt settlement remains
   * per-entry and must keep using removeProcessedAcrossUsers.
   */
  removeProcessingGroupAcrossUsers(threadId: string, entryId: string): QueueEntry[] | null {
    const group = this.resolveProcessingGroupAcrossUsers(threadId, entryId);
    if (!group) return null;
    const removed = group.members.map((member) => member.candidate);
    for (const member of [...group.members].sort((left, right) => right.index - left.index)) {
      const removedEntry = group.queue.splice(member.index, 1)[0];
      if (removedEntry) this.originalContents.delete(removedEntry.id);
    }
    if (group.reservationId) this.exactSteerReservations.delete(group.reservationId);
    return removed;
  }

  /**
   * Find the in-flight (processing) entry occupying a cat's per-cat slot in a thread, across all
   * users. 2026-06-02 (Steer 无法抢占): steer-immediate uses this to locate the entry whose
   * executeEntry holds the slot, so it can tombstone it (removeProcessedAcrossUsers) instead of
   * force-releasing the slot — the tombstone makes executeEntry self-abort at its post-startAll
   * guard, which is race-safe through the pre-start (create-await) window. Returns null if none.
   */
  findProcessingByCat(threadId: string, catId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find((e) => e.status === 'processing' && (e.targetCats[0] ?? 'unknown') === catId);
      if (entry) return entry;
    }
    return null;
  }

  /** Get unique userIds that have entries (any status) for this thread. */
  listUsersForThread(threadId: string): string[] {
    const users: string[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId) || q.length === 0) continue;
      users.push(q[0]!.userId);
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
          !e.autoExecute ||
          !e.targetCats.some((catId) => isOrdinaryQueueTargetEligible(e, catId))
        )
          continue;
        result.push({ ...e });
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
        if (e.from.kind !== 'agent' || !e.targetCats.some((catId) => isQueueTargetPending(e, catId))) continue;
        count++;
      }
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

  /**
   * F-coalesce: find the best in-flight agent entry to coalesce a same-turn handoff into.
   *
   * Used by callback-a2a-trigger to merge a caller's repeated same-turn handoffs to the same target
   * instead of dispatching duplicate invocations. Resolution PREFERS a mergeable 'queued' entry over
   * a 'processing' one: a queued entry can be merged in place (coalesceContentIntoQueuedAgent),
   * whereas a processing entry is already running and can only be superseded (abort+restart, deferred
   * to F216). So when a cat has BOTH a running entry and a queued follow-up, a third handoff must
   * merge into the queued follow-up — not spawn yet another entry. Hence the two-pass scan.
   *
   * Stale processing entries (zombie invocations past STALE_PROCESSING_THRESHOLD_MS) are ignored so
   * a hung invocation never permanently swallows new handoffs. Returns a copy (never a live ref).
   */
  findInFlightAgentEntry(
    threadId: string,
    catId: string,
    callerCatId?: string,
    a2aParentInvocationId?: string,
    ownerAuthProvenance?: OwnerAuthProvenance,
  ): QueueEntry | null {
    // 云端 codex R4 P1: scope to sourceCategory 'a2a'. `source: 'agent'` alone also matches
    // self-continuation entries (QueueProcessor.enqueueContinuation → source:'agent',
    // sourceCategory:'continuation'). Without this filter an A2A handoff to a cat that has a queued
    // continuation would merge INTO the continuation prompt — mixing unrelated control-flow content
    // with another cat's handoff AND suppressing the real A2A route. Only same-category 'a2a' entries
    // are the caller's repeated same-turn handoffs and thus semantically mergeable. (Mirrors the
    // existing sourceCategory discrimination in isSystemPinnedQueueEntry / normalizedPriority.)
    //
    // F216 c0 (砚砚 GPT-5.5 review P1): ALSO scope by callerCatId. Only the SAME caller's repeated
    // same-turn handoffs are mergeable — without this, cat A's queued handoff to a target gets
    // coalesced/superseded by cat B's later handoff to the same target (cross-caller串味).
    //
    // Parallel invocations of one cat still share callerCatId, so callback callers additionally
    // pass a2aParentInvocationId. Both supplied scopes use strict matching: a missing field never
    // adopts a scoped lookup. Omitted scopes preserve compatibility for legacy/non-invocation
    // callers, preferring a fresh entry whenever the lineage is known but does not match.
    const matches = (e: QueueEntry): boolean => {
      if (!(e.from.kind === 'agent' && e.sourceCategory === 'a2a' && isOrdinaryQueueTargetEligible(e, catId))) {
        return false;
      }
      if (callerCatId !== undefined && e.from.catId !== callerCatId) return false;
      if (
        a2aParentInvocationId !== undefined &&
        !(e.a2aParentInvocationId !== undefined && e.a2aParentInvocationId === a2aParentInvocationId)
      ) {
        return false;
      }
      if (ownerAuthProvenance !== undefined && e.ownerAuthProvenance !== ownerAuthProvenance) return false;
      return true;
    };
    // Pass 1: prefer a mergeable queued entry (in-place coalesce, no abort needed).
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (matches(e) && e.status === 'queued') return { ...e };
      }
    }
    // Pass 2: fall back to a fresh (non-stale) processing entry — caller defers supersede to F216.
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (!matches(e) || e.status !== 'processing') continue;
        const age = now - (e.processingStartedAt ?? e.createdAt);
        if (age < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) return { ...e };
      }
    }
    return null;
  }

  /**
   * F-coalesce: merge new content + messageId into an existing QUEUED agent entry.
   *
   * Only succeeds while the entry is still 'queued' (not yet dispatched) — returns false if it has
   * already started processing (the caller must supersede via abort+restart instead, see F216).
   * Content is appended with a blank-line separator so the target cat sees both handoffs as one
   * coherent A2A message without changing public conversation-prefix batching. The new messageId is
   * tracked in mergedMessageIds so delivery/ack covers both trigger messages.
   */
  coalesceContentIntoQueuedAgent(
    threadId: string,
    userId: string,
    entryId: string,
    content: string,
    messageId?: string,
    callerCatId?: string,
    a2aParentInvocationId?: string,
    ownerAuthProvenance?: OwnerAuthProvenance,
    targetCatId?: string,
    queueCustodyAdmissionId?: string,
  ): boolean {
    const e = this.findEntry(threadId, userId, entryId);
    if (!e || e.status !== 'queued') return false;
    // 云端 codex R4 P1 (defense-in-depth): only A2A entries are mergeable. findInFlightAgentEntry
    // already scopes to sourceCategory 'a2a', but guard here too so a future caller passing a
    // continuation/other entryId can never splice a handoff into unrelated control-flow content.
    if (!(e.from.kind === 'agent' && e.sourceCategory === 'a2a')) return false;
    const intendedTargetCatId = targetCatId ?? e.targetCats[0];
    if (!intendedTargetCatId || !isOrdinaryQueueTargetEligible(e, intendedTargetCatId)) return false;
    // Defense-in-depth source scope: a stale/wrong entryId from another caller or parallel
    // invocation can never splice content. Supplied scopes require a defined exact match; omitted
    // scopes stay off for legacy/non-invocation callers.
    if (callerCatId !== undefined && e.from.catId !== callerCatId) return false;
    if (
      a2aParentInvocationId !== undefined &&
      !(e.a2aParentInvocationId !== undefined && e.a2aParentInvocationId === a2aParentInvocationId)
    ) {
      return false;
    }
    if (ownerAuthProvenance !== undefined && e.ownerAuthProvenance !== ownerAuthProvenance) return false;
    if (e.queueCustodyAdmissionId) return false;
    e.content = `${e.content}\n\n${content}`;
    if (messageId && e.messageId !== messageId && !e.mergedMessageIds.includes(messageId)) {
      e.mergedMessageIds.push(messageId);
    }
    // New queued content invalidates previous read markers; the target has not seen the appended body.
    e.queuedNotifiedByCatIds = undefined;
    e.queuedSeenByCatIds = undefined;
    e.queuedSeenInvocationIdByCatId = undefined;
    e.queueCustodyAdmissionId = queueCustodyAdmissionId;
    return true;
  }

  /**
   * Cross-path dedup: checks processing + fresh queued agent entries.
   * Used by route-serial to prevent text-scan @mention when callback already dispatched.
   *
   * 'processing' entries block only if fresh (< STALE_PROCESSING_THRESHOLD_MS).
   * Zombie processing entries (invocation hung without cleanup) are ignored to
   * prevent permanent A2A routing deadlock.
   *
   * 'queued' entries always block: they are legitimate pending dispatches and
   * listAutoExecute/markProcessingAcrossUsers will still pick them up after a long wait.
   */
  static readonly STALE_PROCESSING_THRESHOLD_MS = 600_000; // 10 minutes

  hasActiveOrQueuedAgentForCat(threadId: string, catId: string, opts?: { excludeEntryId?: string }): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (opts?.excludeEntryId && e.id === opts.excludeEntryId) continue;
        if (e.from.kind !== 'agent' || !isQueueTargetPending(e, catId)) continue;

        if (e.status === 'processing') {
          // Use processingStartedAt (when the entry actually began processing),
          // NOT createdAt (when it was enqueued). An entry may sit queued for a
          // long time before being picked up — using createdAt would falsely
          // expire it the moment it starts processing. (P1 fix per codex review)
          const processingAge = now - (e.processingStartedAt ?? e.createdAt);
          if (processingAge < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) {
            this.log?.info(
              {
                threadId,
                catId,
                matchedEntry: {
                  entryId: e.id,
                  status: e.status,
                  processingAgeMs: processingAge,
                  userId: e.userId,
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
                userId: e.userId,
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
                queuedAgeMs: now - e.createdAt,
                userId: e.userId,
              },
            },
            '[DIAG] hasActiveOrQueuedAgentForCat hit',
          );
          return true;
        }
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
        if (opts?.userId && e.userId !== opts.userId) continue;
        if (!isQueueTargetPending(e, catId)) continue;
        if (opts?.sources && !opts.sources.includes(queueEntrySource(e))) continue;
        if (opts?.sourceCategories) {
          if (!e.sourceCategory || !opts.sourceCategories.includes(e.sourceCategory)) continue;
        }
        if (opts?.continuationKey !== undefined && e.continuationKey !== opts.continuationKey) continue;

        if (e.status === 'queued') {
          return true;
        }

        if (e.status === 'processing') {
          const processingAge = now - (e.processingStartedAt ?? e.createdAt);
          if (processingAge >= InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) {
            this.log?.warn(
              {
                threadId,
                catId,
                matchedEntry: {
                  entryId: e.id,
                  status: e.status,
                  processingAgeMs: processingAge,
                  userId: e.userId,
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
    return false;
  }

  /** F122B: Mark a specific entry as processing by ID (cross-user). */
  markProcessingById(
    threadId: string,
    entryId: string,
    targetCatId?: string,
    resolvedTargetCats?: readonly string[],
  ): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find((e) => e.id === entryId && e.status === 'queued' && !e.exactSteerBatch);
      if (entry) {
        if (resolvedTargetCats) {
          if (
            resolvedTargetCats.length === 0 ||
            resolvedTargetCats.some((catId) => typeof catId !== 'string' || !catId) ||
            new Set(resolvedTargetCats).size !== resolvedTargetCats.length
          ) {
            return false;
          }
          entry.targetCats = [...resolvedTargetCats];
          entry.allTargetCats = [...resolvedTargetCats];
        }
        const selectedTargetCatId =
          targetCatId ?? entry.targetCats.find((catId) => isOrdinaryQueueTargetEligible(entry, catId));
        if (!selectedTargetCatId || !isOrdinaryQueueTargetEligible(entry, selectedTargetCatId)) return false;
        return this.markEntryProcessing(entry, undefined, selectedTargetCatId) !== null;
      }
    }
    return false;
  }

  /**
   * RFC #1356 §6.4: return the longest still-queued public-conversation
   * prefix immediately after an already-claimed comparator head.
   *
   * Sender identity is deliberately not a compatibility key: user, connector,
   * plugin and public system inputs share `conversation_input`. Every returned
   * row remains an independent Queue/History identity; the processor only gives
   * the compatible rows one Agent Client dispatch.
   */
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
      head.status !== 'processing' ||
      head.targetCats.length === 0 ||
      head.position !== undefined ||
      head.exactSteerBatch ||
      head.queuedFailedByCatIds?.length ||
      head.steerRequestedByCatIds?.length
    ) {
      return [];
    }

    const queued: QueueEntry[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, head.threadId)) continue;
      queued.push(...q.filter((entry) => entry.status === 'queued' && !entry.exactSteerBatch));
    }
    queued.sort(InvocationQueue.compareEntries);

    const headTargets = sorted([...(resolution?.requestedTargets ?? head.targetCats)]);
    const routingClass = resolution?.routingClass ?? 'explicit';
    const prefix: QueueEntry[] = [];
    for (const candidate of queued) {
      if (
        candidate.kind !== 'conversation_input' ||
        candidate.userId !== head.userId ||
        candidate.intent !== head.intent ||
        candidate.ownerAuthProvenance !== head.ownerAuthProvenance ||
        candidate.position !== undefined ||
        candidate.queuedFailedByCatIds?.length ||
        candidate.steerRequestedByCatIds?.length ||
        (routingClass === 'targetless'
          ? candidate.targetCats.length !== 0
          : !arraysEqual(sorted(candidate.targetCats), headTargets)) ||
        (routingClass === 'explicit' &&
          candidate.targetCats.some((catId) => !isOrdinaryQueueTargetEligible(candidate, catId)))
      ) {
        break;
      }
      prefix.push(InvocationQueue.cloneEntry(candidate));
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
        if (e.status === 'processing') {
          const age = now - (e.processingStartedAt ?? e.createdAt);
          if (age < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) return true;
        }
      }
    }
    return false;
  }

  /** Queue custody remains thread-visible until an explicit admission or terminal transition removes it. */
  hasQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((entry) => entry.status === 'queued')) return true;
    }
    return false;
  }

  /** Whether ordinary scheduling has at least one nonfailed target to select. */
  hasOrdinaryEligibleQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (
        q.some(
          (entry) =>
            entry.status === 'queued' && entry.targetCats.some((catId) => isOrdinaryQueueTargetEligible(entry, catId)),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether Queue still owns work for this thread, including failed targets
   * awaiting explicit retry. Actual dispatch selectors apply per-target
   * eligibility separately.
   */
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
