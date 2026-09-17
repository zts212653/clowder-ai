import type { ThreadProposal } from '@cat-cafe/shared';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { appendApprovedInitialMessage } from './proposal-approve-dispatch.js';
import type { ProposalRoutesOptions } from './proposal-route-options.js';

export interface ReconcileApprovedSeedDeps
  extends Pick<
    ProposalRoutesOptions,
    'messageStore' | 'threadStore' | 'socketManager' | 'router' | 'invocationQueue' | 'queueProcessor'
  > {
  proposal: ThreadProposal;
  userId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
}

export interface ReconcileApprovedInitialMessageResult {
  /** Warnings from best-effort side effects. Empty when the seed was already present or appended cleanly. */
  warnings: string[];
  /** True when a seed (idempotency-keyed or legacy) already existed and no append was attempted. */
  wasPresent: boolean;
  /** True when the existing seed was detected via the legacy scan. */
  legacy?: boolean;
  /** True when the seed was repaired by re-dispatching a previously materialized but undispatched seed. */
  redispatched?: boolean;
}

export interface ReconcileFactoryDeps
  extends Pick<
    ProposalRoutesOptions,
    'messageStore' | 'threadStore' | 'socketManager' | 'router' | 'invocationQueue' | 'queueProcessor'
  > {
  userId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
}

export function createReconcileApprovedInitialMessage({
  userId,
  ownerAuthProvenance,
  messageStore,
  threadStore,
  socketManager,
  router,
  invocationQueue,
  queueProcessor,
}: ReconcileFactoryDeps) {
  return (proposal: ThreadProposal) =>
    reconcileApprovedInitialMessage({
      proposal,
      userId,
      ownerAuthProvenance,
      messageStore,
      threadStore,
      socketManager,
      router,
      invocationQueue,
      queueProcessor,
    });
}

/**
 * #1387 / #1406 B1: materialization and wake-completion are separate facts.
 * A seed is dispatch-complete only when it has reached a terminal delivery
 * state. Owning queue custody or merely being 'queued' does NOT mean the
 * queue processor successfully woke the target — processNext may throw or
 * return started:false, leaving the seed in an indistinguishable 'queued'
 * state that must be retried.
 */
function isDispatchComplete(message: StoredMessage): boolean {
  return message.deliveryStatus === 'delivered' || message.deliveryStatus === 'canceled';
}

/**
 * #1387: backward-compatible detection for proposal seeds written before the
 * `proposal-initial:<id>` idempotency-key index. Scans the entire child thread
 * and matches proposal-specific evidence so unrelated cross-posts from the same
 * source thread are not mistaken for the seed.
 */
export async function findLegacyProposalSeed(
  proposal: ThreadProposal,
  userId: string,
  messageStore: IMessageStore,
): Promise<StoredMessage | null> {
  // Both Memory and Redis implementations of getByThreadAfter return every
  // retained message when `limit` is omitted. Include queued work because a
  // legacy seed may still be queued if dispatch crashed before delivery.
  const candidates = await messageStore.getByThreadAfter(proposal.createdThreadId!, undefined, undefined, userId, {
    includeQueuedCatMessages: true,
    includeQueuedUserMessages: true,
  });

  const sourceEnvelopePrefix = `**来源**: ${proposal.title}`;
  return (
    candidates.find((m) => {
      // The seed author is the proposal source cat (AC-AA4).
      if (m.catId !== proposal.sourceCatId) return false;
      const crossPost = m.extra?.crossPost;
      if (!crossPost) return false;
      // Cross-post sourceThreadId is NOT proposal-specific on its own — ordinary
      // cross-thread callbacks also carry it (packages/api/src/routes/callbacks.ts).
      if (crossPost.sourceThreadId !== proposal.sourceThreadId) return false;
      // When the proposal records an exact trigger message and the seed cross-post
      // carries one, they must match. Legacy seeds predate this field, so a missing
      // sourceMessageId in the seed is allowed.
      if (
        proposal.sourceMessageId &&
        crossPost.sourceMessageId &&
        crossPost.sourceMessageId !== proposal.sourceMessageId
      ) {
        return false;
      }
      // The source envelope content is unique to this proposal's seed; cross-posts
      // from callbacks do not include the proposal title/reason envelope.
      return m.content.includes(sourceEnvelopePrefix);
    }) ?? null
  );
}

async function dispatchApprovedInitialMessage(
  proposal: ThreadProposal,
  userId: string,
  ownerAuthProvenance: OwnerAuthProvenance,
  messageStore: IMessageStore,
  threadStore: Pick<ReconcileApprovedSeedDeps['threadStore'], 'get' | 'addParticipants'>,
  socketManager: ReconcileApprovedSeedDeps['socketManager'],
  router: ReconcileApprovedSeedDeps['router'],
  invocationQueue: ReconcileApprovedSeedDeps['invocationQueue'],
  queueProcessor: ReconcileApprovedSeedDeps['queueProcessor'],
  existingSeed?: StoredMessage,
): Promise<{ warnings: string[] }> {
  // Best-effort source-thread title: a transient store failure here must not
  // drop dispatch after the proposal has already been finalized.
  let sourceThreadTitle: string | null | undefined;
  try {
    sourceThreadTitle = (await threadStore.get(proposal.sourceThreadId))?.title;
  } catch {
    sourceThreadTitle = undefined;
  }

  const warnings: string[] = [];
  try {
    const result = await appendApprovedInitialMessage({
      proposalId: proposal.proposalId,
      userId,
      ownerAuthProvenance,
      threadId: proposal.createdThreadId!,
      rawInitialMessage: proposal.initialMessage,
      sourceEnvelope: {
        title: proposal.title,
        reason: proposal.reason,
        sourceMessageId: proposal.sourceMessageId,
      },
      sourceThreadId: proposal.sourceThreadId,
      sourceThreadTitle,
      preferredCats: proposal.preferredCats,
      reportingMode: proposal.reportingMode,
      declaredWorkMode: proposal.declaredWorkMode,
      sourceCatId: proposal.sourceCatId,
      sourceInvocationId: proposal.sourceInvocationId,
      messageStore,
      threadStore,
      socketManager,
      router,
      invocationQueue,
      queueProcessor,
      existingSeed,
    });
    if (result.warning) warnings.push(result.warning);
  } catch (err) {
    warnings.push(`initialMessage append failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { warnings };
}

/**
 * #1387: idempotently append the child seed for an already-approved proposal whose
 * first approve finalized the thread but failed to dispatch the initial message.
 * Returns any warnings from the best-effort dispatch.
 */
export async function reconcileApprovedInitialMessage({
  proposal,
  userId,
  ownerAuthProvenance,
  messageStore,
  threadStore,
  socketManager,
  router,
  invocationQueue,
  queueProcessor,
}: ReconcileApprovedSeedDeps): Promise<ReconcileApprovedInitialMessageResult> {
  const threadId = proposal.createdThreadId!;

  // All pre-append reads are best-effort. If we cannot establish whether a seed
  // already exists, we must NOT append — that would duplicate the seed and can
  // re-run agent work or external side effects.
  try {
    const idempotentSeed = await messageStore.getByIdempotencyKey(
      userId,
      threadId,
      `proposal-initial:${proposal.proposalId}`,
    );
    if (idempotentSeed) {
      // The seed is materialized, but queue-full / processNext failure can leave
      // it without queue custody. In that case the seed is NOT dispatch-complete;
      // retry dispatch exactly once per reconcile call.
      if (isDispatchComplete(idempotentSeed)) {
        return { warnings: [], wasPresent: true };
      }
      const { warnings } = await dispatchApprovedInitialMessage(
        proposal,
        userId,
        ownerAuthProvenance,
        messageStore,
        threadStore,
        socketManager,
        router,
        invocationQueue,
        queueProcessor,
      );
      return { warnings, wasPresent: true, redispatched: true };
    }

    const legacySeed = await findLegacyProposalSeed(proposal, userId, messageStore);
    if (legacySeed) {
      // #1406 B1: legacy seeds are subject to the same materialization-vs-wake
      // invariant as indexed seeds. A legacy queue-full row can be permanently
      // unwoken if we treat its mere existence as completion.
      if (isDispatchComplete(legacySeed)) {
        return { warnings: [], wasPresent: true, legacy: true };
      }
      const { warnings } = await dispatchApprovedInitialMessage(
        proposal,
        userId,
        ownerAuthProvenance,
        messageStore,
        threadStore,
        socketManager,
        router,
        invocationQueue,
        queueProcessor,
        legacySeed,
      );
      return { warnings, wasPresent: true, legacy: true, redispatched: true };
    }
  } catch (err) {
    return {
      warnings: [`cannot verify proposal seed existence: ${err instanceof Error ? err.message : String(err)}`],
      wasPresent: false,
    };
  }

  const { warnings } = await dispatchApprovedInitialMessage(
    proposal,
    userId,
    ownerAuthProvenance,
    messageStore,
    threadStore,
    socketManager,
    router,
    invocationQueue,
    queueProcessor,
  );
  return { warnings, wasPresent: false };
}
