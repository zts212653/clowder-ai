import { isDeepStrictEqual } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import type { OwnerAuthProvenance } from '../../owner-auth-provenance.js';
import type { AppendMessageInput, IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';
import type { OwnedQueueProgress, PersistedCarrierResult } from './PersistedQueueCarrier.js';
import { queueEntryId } from './queue-ledger/QueueLedger.js';

export interface PersistedQueueDeliveryInput {
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  idempotencyKey: string;
  content: string;
  source: NonNullable<StoredMessage['source']>;
  /** Producer-owned envelope metadata (e.g. memory cues); never routing or reliability state. */
  extra?: NonNullable<StoredMessage['extra']>;
  /** RFC §5.1: the envelope states its own urgency; the Queue never infers it from the payload. */
  priority?: 'urgent' | 'normal';
  /**
   * RFC §5.1 lists user, external connector, plugin AND system producers under the same envelope.
   * The producer declares who it is; defaults to the external-connector shape from `source.sender`.
   * `source.label` names the ROOM and is never an actor — see the derivation below.
   */
  from?: StoredMessage['from'];
  /** Verified owner provenance for producers that carry an explicit authorization. */
  ownerAuthProvenance?: OwnerAuthProvenance;
  /** Producer hint about which skill this input needs; carried on the Queue row, not inferred. */
  suggestedSkill?: string;
  /** Producer's own category label for the Queue row (ci / review / scheduled / issue / a2a). */
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
  /** Structured payload parts (IM media, cards) that belong to the same input as its text. */
  contentBlocks?: StoredMessage['contentBlocks'];
  /**
   * When the event happened, for producers that observe the world rather than originate in it — a
   * physical limb captures an utterance at one instant and may be admitted seconds later. Same
   * principle as `priority`: the envelope states its own facts instead of letting admission infer
   * them. Defaults to admission time, which is correct for producers with no distinct event time.
   */
  timestamp?: number;
}

/**
 * RFC §5.1's third envelope: an input whose payload belongs only to its target. It is admitted to
 * the same priority Queue and dispatched by the same drain, but it creates no public History
 * message — §5.4: "不在用户 Queue Panel 或聊天面板展示，只在被投递目标的 exact input 中可见".
 */
export interface PrivateQueueDeliveryInput {
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  idempotencyKey: string;
  /** The exact input the target receives; never projected into the thread. */
  content: string;
  from: NonNullable<StoredMessage['from']>;
  priority?: 'urgent' | 'normal';
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
  ownerAuthProvenance?: OwnerAuthProvenance;
}

export interface VisibleWithPrivateQueueDeliveryInput extends PrivateQueueDeliveryInput {
  /** The line the thread shows. It is History-only and never becomes executable work. */
  notice: AppendMessageInput;
}

export interface PersistedQueueDeliveryPort {
  deliver(input: PersistedQueueDeliveryInput): Promise<PersistedCarrierResult & { message?: StoredMessage }>;
  /** Admit a target-only payload: same Queue, same drain, no public History member. */
  deliverPrivate(input: PrivateQueueDeliveryInput): Promise<{ admitted: boolean; entryId?: string }>;
  /**
   * Admit a target-only payload and publish the line the thread shows. Durable Queue admission
   * always happens first, so a visible "triggered" notice can never outlive the work it claims.
   */
  deliverVisibleWithPrivateInput(
    input: VisibleWithPrivateQueueDeliveryInput,
  ): Promise<{ admitted: boolean; entryId?: string; notice?: StoredMessage }>;
}

type PersistedQueueDeliveryResult = PersistedCarrierResult & { message?: StoredMessage };

/** Dispatch owns atomic Message + Queue admission; producers supply only an authorized immutable envelope. */
export class PersistedQueueDelivery implements PersistedQueueDeliveryPort {
  constructor(
    private readonly deps: {
      messages: IMessageStore;
      queue: Pick<
        InvocationQueue,
        | 'appendAndEnqueueDurable'
        | 'enqueueDurable'
        | 'enqueueDurableWithVisibleNotice'
        | 'findAdmittedEntriesForMessages'
        | 'getDurableEntry'
      >;
      progress: (entry: QueueEntry, targetCatId: string) => Promise<OwnedQueueProgress>;
    },
  ) {}

  async deliver(input: PersistedQueueDeliveryInput) {
    const targetCat = createCatId(input.targetCatId);
    // `from.sender` is the canonical ACTOR identity: bundle author grouping keys on it, the
    // envelope maps it to `{kind:'user', id}`, and receipts address it. `source.sender` is the
    // person; `source.label` is the room's display name. Defaulting to the label would give every
    // member of a group chat the same fabricated identity named after the room, so a producer that
    // knows no person leaves it absent — consumers already fall back to connectorId/label to show.
    const from =
      input.from ??
      ({
        kind: 'external' as const,
        connectorId: input.source.connector,
        ...(input.source.sender ? { sender: input.source.sender } : {}),
      } as NonNullable<StoredMessage['from']>);
    const existing = await this.deps.messages.getByIdempotencyKey(
      input.ownerUserId,
      input.threadId,
      input.idempotencyKey,
    );
    if (existing) {
      return this.progressExistingMessage(existing, input);
    }
    const admitted = await this.deps.queue.appendAndEnqueueDurable(
      this.deps.messages,
      {
        userId: input.ownerUserId,
        threadId: input.threadId,
        from,
        content: input.content,
        mentions: [targetCat],
        timestamp: input.timestamp ?? Date.now(),
        deliveryStatus: 'queued',
        source: input.source,
        extra: { ...(input.extra ?? {}), targetCats: [targetCat] },
        ...(input.contentBlocks ? { contentBlocks: input.contentBlocks } : {}),
        idempotencyKey: input.idempotencyKey,
      },
      {
        threadId: input.threadId,
        userId: input.ownerUserId,
        sourceId: input.idempotencyKey,
        kind: 'conversation_input',
        // Fail closed: a non-user producer that does not state its provenance is `unknown`. A
        // `strict` value is what grants a ManagedWorkBinding (managed-work-invocation-binding.ts),
        // so inheriting it by default would hand external input the owner's managed-work authority.
        ownerAuthProvenance: input.ownerAuthProvenance ?? 'unknown',
        idempotencyKey: input.idempotencyKey,
        content: input.content,
        from,
        targetCats: [targetCat],
        intent: 'execute',
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.suggestedSkill ? { suggestedSkill: input.suggestedSkill } : {}),
        ...(input.sourceCategory ? { sourceCategory: input.sourceCategory } : {}),
      },
    );
    // Typed like every other queue-full refusal in the codebase (ROUTE_QUEUE_FULL) so callers can
    // tell retryable back-pressure from a genuine fault. A bare Error forces them to either mask
    // real bugs as back-pressure or let back-pressure escape as a 500.
    if (admitted.outcome === 'full') {
      throw Object.assign(new Error('Producer return queue is full'), { code: 'ROUTE_QUEUE_FULL' });
    }
    const message = admitted.message;
    if (!matchesPersistedEnvelope(message, input)) {
      return { state: 'conflict' as const, reason: 'Persisted producer envelope does not match', message };
    }
    const entry = admitted.entry;
    if (!entry) return { state: 'unavailable' as const, reason: 'Queue admission is unavailable', message };
    if (entry.status === 'claimed' || entry.status === 'processing') {
      return { state: 'already_processing' as const, entryId: entry.id, message };
    }
    return { state: await this.deps.progress(entry, input.targetCatId), entryId: entry.id, message };
  }

  async deliverPrivate(input: PrivateQueueDeliveryInput): Promise<{ admitted: boolean; entryId?: string }> {
    const row = await this.admitPrivateRow(input);
    if (!row.admitted) return { admitted: false };
    if (!row.entry) return { admitted: true };
    if (row.entry.status !== 'claimed' && row.entry.status !== 'processing') {
      await this.deps.progress(row.entry, input.targetCatId);
    }
    return { admitted: true, entryId: row.entry.id };
  }

  /**
   * The one envelope shape for private work, shared by the bare and notice-carrying paths.
   *
   * Both must produce byte-identical rows: the admission receipt is keyed on this envelope's
   * fingerprint, so any divergence would make the same logical input look like a conflicting one.
   */
  private privateEnqueueInput(input: PrivateQueueDeliveryInput) {
    return {
      threadId: input.threadId,
      userId: input.ownerUserId,
      sourceId: input.idempotencyKey,
      kind: 'private_input' as const,
      ownerAuthProvenance: input.ownerAuthProvenance ?? ('unknown' as const),
      idempotencyKey: input.idempotencyKey,
      content: input.content,
      from: input.from,
      targetCats: [createCatId(input.targetCatId)],
      intent: 'execute' as const,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.sourceCategory ? { sourceCategory: input.sourceCategory } : {}),
    };
  }

  /** Durable Queue admission for a target-only payload, without starting the work. */
  private async admitPrivateRow(input: PrivateQueueDeliveryInput): Promise<{ admitted: boolean; entry?: QueueEntry }> {
    const admitted = await this.deps.queue.enqueueDurable(this.privateEnqueueInput(input));
    if (admitted.outcome === 'full') return { admitted: false };
    const entry = admitted.entry;
    if (!entry) {
      // A replayed stable key whose row already retired at the processing boundary. The durable
      // admission receipt is the winner, so this identity is admitted and must not run again.
      // Reporting a refusal here would push a receipt-completion retry into an endless loop.
      return admitted.deduped ? { admitted: true } : { admitted: false };
    }
    return { admitted: true, entry };
  }

  async deliverVisibleWithPrivateInput(
    input: VisibleWithPrivateQueueDeliveryInput,
  ): Promise<{ admitted: boolean; entryId?: string; notice?: StoredMessage }> {
    // One transition for both halves. Ordering two writes is not enough: whichever runs second can
    // fail, leaving either a visible "triggered" notice with no admitted work, or durable work whose
    // producer was handed an error and will report `trigger_failed` while the work still runs.
    const admitted = await this.deps.queue.enqueueDurableWithVisibleNotice(
      this.privateEnqueueInput(input),
      input.notice,
      this.deps.messages,
    );
    if (admitted.outcome === 'full') return { admitted: false };
    const entry = admitted.entry;
    if (entry && entry.status !== 'claimed' && entry.status !== 'processing') {
      await this.deps.progress(entry, input.targetCatId);
    }
    return {
      admitted: true,
      ...(entry ? { entryId: entry.id } : {}),
      ...(admitted.notice ? { notice: admitted.notice } : {}),
    };
  }

  private async progressExistingMessage(
    existing: StoredMessage,
    input: PersistedQueueDeliveryInput,
  ): Promise<PersistedQueueDeliveryResult> {
    if (!matchesPersistedEnvelope(existing, input)) {
      return { state: 'conflict', reason: 'Persisted producer envelope does not match', message: existing };
    }
    const entryId = queueEntryId(existing.id);
    const entry = await this.deps.queue.getDurableEntry(input.threadId, entryId);
    if (entry) {
      if (entry.status === 'claimed' || entry.status === 'processing') {
        return { state: 'already_processing', entryId, message: existing };
      }
      if (entry.status === 'terminal') return { state: 'terminal_owned', entryId, message: existing };
      return { state: await this.deps.progress(entry, input.targetCatId), entryId, message: existing };
    }
    if (
      this.deps.queue.findAdmittedEntriesForMessages(
        input.threadId,
        [existing.id],
        input.ownerUserId,
        input.targetCatId,
      ).length > 0
    ) {
      return { state: 'already_processing', entryId, message: existing };
    }
    if (existing.deliveryStatus === 'delivered') {
      return { state: 'terminal_owned', entryId, message: existing };
    }
    return { state: 'conflict', reason: 'Persisted producer Queue carrier is missing', message: existing };
  }
}

function matchesPersistedEnvelope(message: StoredMessage, input: PersistedQueueDeliveryInput): boolean {
  return (
    message.userId === input.ownerUserId &&
    message.threadId === input.threadId &&
    message.content === input.content &&
    message.source?.connector === input.source.connector &&
    isDeepStrictEqual(message.source.meta, input.source.meta) &&
    message.mentions.some((cat) => cat === input.targetCatId)
  );
}
