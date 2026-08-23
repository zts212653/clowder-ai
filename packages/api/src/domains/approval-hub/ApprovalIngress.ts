import type { ApprovalEnvelope, ApprovalOriginRef, ApprovalProducerId, CatId, RichBlock } from '@cat-cafe/shared';
import { approvalProducerMeta, validateApprovalEnvelope, validateApprovalOriginRef } from '@cat-cafe/shared';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isSystemUserMessage } from '../cats/services/stores/visibility.js';
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
    // must NOT short-circuit the other — broadcastToRoom (chat projection)
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
    // Cross-tenant isolation here is a CONJUNCTION of two parts, and neither part
    // is sufficient on its own (@codex-luna's review, rounds 2-4):
    //
    //   (1) CALLER: originRef.threadId / .messageId and ownerUserId must be bound
    //       to an authenticated record. This class CANNOT verify that binding.
    //   (2) THIS CLASS: the assertion above checks that the origin message really
    //       does live in the thread the draft names.
    //
    // (2) alone proves nothing about tenancy — a draft naming a thread of its own
    // choosing satisfies the comparison trivially. It carries weight only because
    // (1) fixes which thread may be named. On the F225 session-handoff path (1)
    // holds: that producer derives all three from an authenticated
    // InvocationRecord, and a request body cannot rewrite them.
    //
    // ApprovalIngress serves several producers, so (1) is a property of a PATH and
    // never of this class. An earlier revision only documented that and let the
    // exemption apply to every message-origin producer — which made the exemption
    // as wide as the shared ingress while the argument for it covered one caller
    // (maintainer review, PR #1347 gate 2).
    //
    // So the exemption is no longer global: it is gated per producer by
    // `systemOriginExemption` in the producer catalog, and a required field means a
    // new producer cannot inherit it by omission.
    //
    // Be precise about what that gate is (@codex-luna, PR #1349 P2). It is a
    // CAPABILITY GATE over a DECLARATION — the catalog says which producers claim
    // the binding of (1). It is NOT a runtime proof that the named adapter really
    // binds: this class cannot verify that, and a wrong `server_attested` value
    // would not be caught here. The proof lives in the per-entry audit trail plus
    // route-level coverage. So the gate narrows the blast radius from "every
    // message-origin producer" to "the ones someone audited and signed for" — which
    // is a real reduction, not a verification.
    //
    // Given (1) AND (2), what the comparison below still decides is narrower: who
    // may have authored a row inside an already-verified thread — and a system
    // pseudo-user speaking in that thread is not another tenant.
    //
    // Without the exemption this rejected precisely the sessions that need it most.
    // A session-handoff proposal anchors on the message that triggered the
    // invocation, and for any long-running session that message IS the scheduler's
    // wake row ("持球唤醒"), persisted as userId='scheduler' / catId=null. So a
    // timer-woken cat could never hand off, while the same proposal from an
    // A2A-triggered turn (authored by the real owner) went through — the failure
    // was invisible except as a 500 with no actionable text.
    //
    // isSystemUserMessage is the store layer's existing predicate for exactly this
    // distinction, and it is deliberately reused rather than re-derived here: it
    // requires BOTH a system userId AND a system/null catId, so a cat-authored row
    // wearing a system userId stays rejected. A second, private definition of "is
    // this the system" is how the two drift apart.
    const systemOriginExempt = approvalProducerMeta(draft.producerId).systemOriginExemption === 'server_attested';
    if (origin.userId !== draft.ownerUserId && !(systemOriginExempt && isSystemUserMessage(origin))) {
      throw new Error('Approval origin message owner mismatch');
    }
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
    // A reconnecting socket joins its durable user room synchronously, while
    // desired thread rooms are reconciled asynchronously by the client. Fan
    // the same committed card to the UNION of both rooms so a proposal created
    // in that window still reaches the source-thread projection. Socket.IO's
    // multi-room operator emits once per socket even when it belongs to both.
    this.deps.socketManager.broadcastToRoom(
      [`thread:${draft.cardThreadId}`, `user:${draft.ownerUserId}`],
      'connector_message',
      {
        threadId: draft.cardThreadId,
        message: {
          id: stored.id,
          type: 'cat',
          catId: draft.requesterCatId,
          content: stored.content,
          timestamp: stored.timestamp,
          extra: stored.extra,
        },
      },
    );
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
