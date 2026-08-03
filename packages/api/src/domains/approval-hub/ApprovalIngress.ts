import type { ApprovalEnvelope, ApprovalOriginRef, ApprovalProducerId, CatId, RichBlock } from '@cat-cafe/shared';
import { approvalProducerMeta, validateApprovalEnvelope, validateApprovalOriginRef } from '@cat-cafe/shared';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { approvalCardIdempotencyKey, buildApprovalCardBlock } from './buildApprovalCardBlock.js';
import type { ApprovalPublicationStore } from './ports/ApprovalPublicationStore.js';

const RECOVERY_SCAN_LIMIT = 10_000;

/**
 * Thrown by ApprovalIngress when commitEnvelope fails AFTER the approval card
 * has been persisted.  Callers must NOT abort the staged publication on this
 * error — the staged proposal + persisted card form the recovery path for
 * idempotent retry (AC-I8 two-phase commit contract).
 *
 * Pre-card failures (validation, unrecoverable card-append failure) are handled
 * internally by ApprovalIngress (staged is aborted inside publishOnce) and
 * throw a plain Error, so the caller can safely clean up supersede/dedup
 * side-effects. If append persisted the card before losing its acknowledgement,
 * publishOnce recovers the card and crosses the post-card boundary below.
 */
export class ApprovalCardCommittedError extends Error {
  readonly cardMessageId: string;
  constructor(cause: unknown, cardMessageId: string) {
    super(
      `Approval envelope commit failed after card was persisted (messageId=${cardMessageId}): ${errorMessage(cause)}`,
    );
    this.name = 'ApprovalCardCommittedError';
    this.cardMessageId = cardMessageId;
    this.cause = cause;
  }
}

type ApprovalIngressMessageStore = Pick<IMessageStore, 'append' | 'getById' | 'getByIdempotencyKey' | 'getByThread'>;

type ApprovalIngressSocketManager = Pick<SocketManager, 'broadcastToRoom' | 'emitToUser'>;

export interface ApprovalPublishDraft {
  producerId: ApprovalProducerId;
  canonicalProposalId: string;
  ownerUserId: string;
  requesterCatId: CatId;
  originRef: ApprovalOriginRef;
  cardThreadId: string;
  cardContent: string;
  cardBlock: RichBlock;
  createdAt: number;
}

export interface ApprovalIngressDeps {
  messageStore: ApprovalIngressMessageStore;
  socketManager: ApprovalIngressSocketManager;
}

export interface LegacyApprovalCardLookup {
  producerId: ApprovalProducerId;
  canonicalProposalId: string;
  ownerUserId: string;
  cardThreadId: string;
  cardBlockId: string;
}

export class ApprovalIngress {
  private readonly inFlight = new Map<string, Promise<ApprovalEnvelope>>();

  constructor(private readonly deps: ApprovalIngressDeps) {}

  publish(draft: ApprovalPublishDraft, store: ApprovalPublicationStore): Promise<ApprovalEnvelope> {
    const key = approvalCardIdempotencyKey(draft);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.publishOnce(draft, store).finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  /** Recover a pre-Phase-I card marker without manufacturing origin/card provenance. */
  async recoverLegacyCard(lookup: LegacyApprovalCardLookup): Promise<string | null> {
    const stored = await this.findPersistedCard(
      lookup.ownerUserId,
      lookup.cardThreadId,
      lookup.cardBlockId,
      approvalCardIdempotencyKey(lookup),
    );
    return isLiveApprovalCard(stored, lookup.ownerUserId, lookup.cardThreadId) ? stored.id : null;
  }

  private async publishOnce(draft: ApprovalPublishDraft, store: ApprovalPublicationStore): Promise<ApprovalEnvelope> {
    const publication = await store.getPublication(draft.canonicalProposalId);
    if (publication?.state === 'anchored') {
      validateApprovalEnvelope(publication.envelope);
      assertEnvelopeMatchesDraft(publication.envelope, draft);
      await this.replayAnchoredFanOut(draft, publication.envelope);
      return publication.envelope;
    }
    if (publication === null || publication.state === 'legacy_unanchored') {
      throw new Error(`Approval publication ${draft.canonicalProposalId} is not staged`);
    }
    if (publication.state === 'tombstoned') {
      throw new Error(`Approval publication ${draft.canonicalProposalId} is tombstoned: ${publication.reason}`);
    }

    let cardBlock: RichBlock;
    try {
      await this.validateOrigin(draft);
      cardBlock = buildApprovalCardBlock(draft, draft.cardBlock);
    } catch (error) {
      await store.abortStaged(draft.canonicalProposalId, errorMessage(error));
      throw error;
    }

    const idempotencyKey = approvalCardIdempotencyKey(draft);
    let stored = await this.findPersistedCard(draft.ownerUserId, draft.cardThreadId, cardBlock.id, idempotencyKey);
    if (!stored) {
      try {
        stored = await this.deps.messageStore.append({
          userId: draft.ownerUserId,
          catId: draft.requesterCatId,
          content: draft.cardContent,
          mentions: [],
          timestamp: draft.createdAt,
          threadId: draft.cardThreadId,
          idempotencyKey,
          extra: { rich: { v: 1, blocks: [cardBlock] } },
        });
      } catch (error) {
        stored = await this.findPersistedCard(draft.ownerUserId, draft.cardThreadId, cardBlock.id, idempotencyKey);
        if (!stored) {
          await store.abortStaged(draft.canonicalProposalId, errorMessage(error));
          throw error;
        }
      }
    }
    // Idempotent append/recovery may return an existing soft-delete or tombstone.
    // Never anchor a proposal to a card that the user can no longer see.
    if (!isLiveApprovalCard(stored, draft.ownerUserId, draft.cardThreadId)) {
      const error = new Error('Approval card is deleted or no longer recoverable');
      await store.abortStaged(draft.canonicalProposalId, error.message);
      throw error;
    }

    // ── Post-card commit boundary ──────────────────────────────────────
    // Card is persisted at this point.  If commitEnvelope fails, the staged
    // publication + persisted card are the idempotent recovery path.
    // Wrap in ApprovalCardCommittedError so callers can distinguish this
    // from pre-card failures (where staged is already aborted internally).
    let envelope: ApprovalEnvelope;
    try {
      envelope = {
        canonicalProposalId: draft.canonicalProposalId,
        sourceFeatureId: draft.producerId,
        ownerUserId: draft.ownerUserId,
        requesterCatId: draft.requesterCatId,
        originRef: draft.originRef,
        approvalCardRef: { threadId: draft.cardThreadId, messageId: stored.id },
        createdAt: draft.createdAt,
      };
      validateApprovalEnvelope(envelope);
      await store.commitEnvelope(draft.canonicalProposalId, envelope);
    } catch (error) {
      throw new ApprovalCardCommittedError(error, stored.id);
    }

    // ── Phase 4: fanout (best-effort) ──────────────────────────────────
    // Envelope is committed — publication is durable.  Each channel is
    // independently isolated inside fanOutAnchoredPublication (R4 P1-2),
    // so no outer catch is needed — partial fanout is observable via logs
    // and retried on next publish() call if needed.
    this.fanOutAnchoredPublication(draft, stored);
    return envelope;
  }

  private async replayAnchoredFanOut(draft: ApprovalPublishDraft, envelope: ApprovalEnvelope): Promise<void> {
    const stored = await this.deps.messageStore.getById(envelope.approvalCardRef.messageId);
    const replayableCard = isLiveApprovalCard(stored, draft.ownerUserId, draft.cardThreadId) ? stored : null;
    // Each channel is independently isolated inside fanOutAnchoredPublication
    // (R4 P1-2) — no outer catch needed.
    this.fanOutAnchoredPublication(draft, replayableCard);
  }

  private fanOutAnchoredPublication(draft: ApprovalPublishDraft, stored: StoredMessage | null): void {
    // R4 P1-2: Each fanout channel is independently isolated.  One failing
    // must NOT short-circuit the other — broadcastToRoom (room participants)
    // and emitToUser (Hub sync trigger) serve different consumers.
    if (stored) {
      try {
        this.broadcastCard(draft, stored);
      } catch (err) {
        console.error(
          `[ApprovalIngress] broadcastToRoom failed for proposal=${draft.canonicalProposalId} feature=${draft.producerId}:`,
          err,
        );
      }
    }
    try {
      this.deps.socketManager.emitToUser(draft.ownerUserId, 'proposal_created', {
        proposalId: draft.canonicalProposalId,
        status: 'pending',
        sourceFeatureId: draft.producerId,
      });
    } catch (err) {
      console.error(
        `[ApprovalIngress] emitToUser failed for proposal=${draft.canonicalProposalId} feature=${draft.producerId}:`,
        err,
      );
    }
  }

  private async validateOrigin(draft: ApprovalPublishDraft): Promise<void> {
    validateApprovalOriginRef(draft.originRef);
    const policy = approvalProducerMeta(draft.producerId).sourcePolicy;
    if (policy === 'message-required' && draft.originRef.kind !== 'message') {
      throw new Error(`Approval producer ${draft.producerId} requires a message origin`);
    }
    if (draft.originRef.kind === 'event') return;
    const origin = await this.deps.messageStore.getById(draft.originRef.messageId);
    if (!origin || origin.deletedAt || origin._tombstone) throw new Error('Approval origin message not found');
    if (origin.threadId !== draft.originRef.threadId) throw new Error('Approval origin message thread mismatch');
    if (origin.userId !== draft.ownerUserId) throw new Error('Approval origin message owner mismatch');
  }

  private async findPersistedCard(
    ownerUserId: string,
    cardThreadId: string,
    blockId: string,
    idempotencyKey: string,
  ): Promise<StoredMessage | null> {
    const indexed = await this.deps.messageStore.getByIdempotencyKey(ownerUserId, cardThreadId, idempotencyKey);
    if (indexed) return indexed;
    const messages = await this.deps.messageStore.getByThread(cardThreadId, RECOVERY_SCAN_LIMIT, ownerUserId);
    return messages.find((message) => message.extra?.rich?.blocks.some((block) => block.id === blockId)) ?? null;
  }

  private broadcastCard(draft: ApprovalPublishDraft, stored: StoredMessage): void {
    this.deps.socketManager.broadcastToRoom(`thread:${draft.cardThreadId}`, 'connector_message', {
      threadId: draft.cardThreadId,
      message: {
        id: stored.id,
        type: 'cat',
        catId: draft.requesterCatId,
        content: stored.content,
        timestamp: stored.timestamp,
        extra: stored.extra,
      },
    });
  }
}

function isLiveApprovalCard(
  stored: StoredMessage | null,
  ownerUserId: string,
  cardThreadId: string,
): stored is StoredMessage {
  return Boolean(
    stored &&
      !stored.deletedAt &&
      !stored._tombstone &&
      stored.userId === ownerUserId &&
      stored.threadId === cardThreadId,
  );
}

function assertEnvelopeMatchesDraft(envelope: ApprovalEnvelope, draft: ApprovalPublishDraft): void {
  if (
    envelope.canonicalProposalId !== draft.canonicalProposalId ||
    envelope.sourceFeatureId !== draft.producerId ||
    envelope.ownerUserId !== draft.ownerUserId ||
    envelope.requesterCatId !== draft.requesterCatId ||
    envelope.approvalCardRef.threadId !== draft.cardThreadId ||
    envelope.createdAt !== draft.createdAt ||
    JSON.stringify(envelope.originRef) !== JSON.stringify(draft.originRef)
  ) {
    throw new Error(`Approval envelope ${draft.canonicalProposalId} conflicts with publish draft`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
