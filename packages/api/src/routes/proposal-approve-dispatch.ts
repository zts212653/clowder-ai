import type { CatId, DeclaredWorkMode, ReportingMode } from '@cat-cafe/shared';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { primaryMentionHandleForCatId } from '../utils/cat-mention-handle.js';
import { enrichWithParentThreadHeader } from './proposal-enrich-header.js';
import {
  buildSourceEnvelopeContent,
  cancelExistingSeed,
  executeQueuedDispatch,
  resolveSourceContentBlocks,
  type SourceEnvelope,
} from './proposal-seed-admission.js';

export { enrichWithParentThreadHeader } from './proposal-enrich-header.js';

type ProposalRouter = Pick<AgentRouter, 'resolveTargetsAndIntent'>;
type ProposalInvocationQueue = Pick<InvocationQueue, 'enqueue' | 'backfillMessageId' | 'rollbackEnqueue'>;
type ProposalQueueProcessor = Pick<QueueProcessor, 'processNext'>;

export interface ProposalInitialMessageDispatchDeps {
  router?: ProposalRouter;
  invocationQueue?: ProposalInvocationQueue;
  queueProcessor?: ProposalQueueProcessor;
}

export interface AppendApprovedInitialMessageInput extends ProposalInitialMessageDispatchDeps {
  proposalId: string;
  userId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
  threadId: string;
  /**
   * Raw user-typed initialMessage. dispatch is now the single owner of the
   * full plan: it runs router resolve + parseIntent + computes effective
   * targets/intent/reporter, then calls enrichWithParentThreadHeader to
   * build the enqueued+stored content. Routes only pass raw user input +
   * parent thread metadata; dispatch handles every transformation.
   *
   * Why this routing flows through dispatch only (round-9 plan-based):
   *   - parseIntent and router.resolveTargetsAndIntent MUST read raw, not
   *     enriched. enriched content carries server-injected text (parent
   *     title, chain protocol) that can trip both `#tag` and `@-mention`
   *     parsers, causing serial proposals to flip to parallel
   *     (round-2 P2) and parent-title `@cat` mentions to silently wake +
   *     persist into participants (round-3 P2).
   *   - The reporter handle for explicit `#ideate` parallel mode must be
   *     derived from the router's resolved catId via
   *     primaryMentionHandleForCatId — NOT from a raw `@<token>` regex
   *     (round-7/8 補锅匠 trap: every handle shape — CJK, dotted,
   *     hyphenated — wanted a new charclass). Plan-based ownership in
   *     dispatch is the only place that has both pieces.
   */
  rawInitialMessage: string | undefined;
  /**
   * Lossless source envelope from the proposal record. When rawInitialMessage is
   * empty, dispatch materializes this envelope as the child-side seed content so
   * the child still receives the original title, reason, and sourceMessageId.
   */
  sourceEnvelope: SourceEnvelope;
  /** Source thread id — injected into the "## 主 Thread" header. */
  sourceThreadId: string;
  /** Source thread title — optional display in the parent header. */
  sourceThreadTitle?: string | null;
  /**
   * Proposed chain participants in user-intended order.
   *
   * Default behaviour: dispatch wakes ONLY `preferredCats[0]` (the chain
   * starter); subsequent cats are driven by the cat-side @-mention chain in
   * their own replies — "他们自己决定下一个要把谁叫出来" (owner spec
   * 2026-05-27).
   *
   * Explicit-intent overrides (read from raw initialMessage, NOT enriched):
   *   - `#ideate` tag → wake all `preferredCats` (or `resolved.targetCats` if
   *     `preferredCats` empty) in parallel; chain protocol injection is
   *     suppressed by `enrichWithParentThreadHeader` so cats are not told to
   *     hand off serially while they were woken parallel (砚砚 round-5 P1).
   *   - `#execute` tag with `preferredCats=[]` and multiple `resolved.targetCats`
   *     → preserve all router-resolved targets (砚砚 round-5 P2: silently
   *     collapsing to the first target would discard explicit user intent).
   */
  preferredCats?: readonly CatId[];
  /** F128 Phase AA (AC-AA1): reporting mode (undefined → enrich default final-only, supersedes AC-Y6 none). */
  reportingMode?: ReportingMode;
  /** F277: approved placement truth, injected into the first message context. */
  declaredWorkMode?: DeclaredWorkMode;
  /** Phase AA (AC-AA4): the cat that proposed this thread — seed message author. */
  sourceCatId?: CatId | null;
  /** Phase AA (AC-AA5): invocation id from the proposal — for crossPost metadata. */
  sourceInvocationId?: string | null;
  messageStore: IMessageStore;
  threadStore: Pick<IThreadStore, 'addParticipants' | 'get'>;
  socketManager: Pick<SocketManager, 'emitToUser'>;
  /**
   * Optional previously-materialized seed (legacy or queue-full) to reuse instead
   * of appending a new message. Used by reconcile to repair an existing row
   * under the materialization-vs-wake-completion invariant.
   */
  existingSeed?: StoredMessage;
}

export interface AppendApprovedInitialMessageResult {
  messageId: string;
  warning?: string;
}

interface DispatchPlan {
  targetCats: readonly CatId[];
  intentName: string;
}

function computeDispatchPlan(
  parsed: { explicit: boolean; intent: string },
  resolvedTargetCats: readonly CatId[],
  preferredCats: readonly CatId[] | undefined,
): DispatchPlan {
  if (parsed.explicit && parsed.intent === 'ideate') {
    return {
      targetCats: preferredCats && preferredCats.length > 0 ? preferredCats : resolvedTargetCats,
      intentName: 'ideate',
    };
  }

  if (
    parsed.explicit &&
    parsed.intent === 'execute' &&
    (!preferredCats || preferredCats.length === 0) &&
    resolvedTargetCats.length > 0
  ) {
    return { targetCats: resolvedTargetCats, intentName: 'execute' };
  }

  const firstCandidate = preferredCats?.[0] ?? resolvedTargetCats[0];
  return { targetCats: firstCandidate ? [firstCandidate] : [], intentName: 'execute' };
}

function computeParallelReporterHandle(
  parsed: { explicit: boolean; intent: string },
  resolvedTargetCats: readonly CatId[],
  preferredCats: readonly CatId[] | undefined,
): string | null {
  if (!parsed.explicit || parsed.intent !== 'ideate') {
    return null;
  }
  const reporterCatId = preferredCats?.[0] ?? resolvedTargetCats[0];
  if (!reporterCatId) {
    return null;
  }
  return primaryMentionHandleForCatId(reporterCatId) ?? `@${reporterCatId}`;
}

export async function appendApprovedInitialMessage({
  proposalId,
  userId,
  ownerAuthProvenance,
  threadId,
  rawInitialMessage,
  sourceEnvelope,
  sourceThreadId,
  sourceThreadTitle,
  preferredCats,
  reportingMode,
  declaredWorkMode,
  sourceCatId,
  sourceInvocationId,
  messageStore,
  threadStore,
  socketManager,
  router,
  invocationQueue,
  queueProcessor,
  existingSeed,
}: AppendApprovedInitialMessageInput): Promise<AppendApprovedInitialMessageResult> {
  // F128 source envelope: seed content uses the envelope only when there is no
  // explicit user-typed initialMessage. Routing/intent must never see the
  // envelope, because title/reason can contain literal @-mentions / #ideate that
  // must not affect dispatch control flow.
  const hasExplicitInitialMessage = rawInitialMessage !== undefined && rawInitialMessage.length > 0;
  const sourceEnvelopeContent = buildSourceEnvelopeContent(sourceEnvelope);
  // #1387: explicit initialMessage controls routing, but the original source
  // envelope (title/reason/PR URL) must remain child-visible so opensource-ops
  // can ground the external object. Append it after a clear separator; routing
  // already consumes rawInitialMessage, so injected envelope text cannot leak
  // into @-mention / #ideate parsing.
  const seedContent = hasExplicitInitialMessage
    ? `${rawInitialMessage}\n\n---\n${sourceEnvelopeContent}`
    : sourceEnvelopeContent;
  const routingInput = rawInitialMessage ?? '';

  // Lossless source: whenever we know the original trigger message, carry over
  // its structured content blocks so the child can read them in-place. This is
  // orthogonal to whether the user supplied an explicit initialMessage — the
  // explicit text controls routing/seed, while the blocks provide the original
  // attachments/links.
  const sourceContentBlocks = await resolveSourceContentBlocks(sourceEnvelope, messageStore);

  // Phase AA (AC-AA5): crossPost metadata for frontend pill + jump-to-source.
  // Also carry the exact source message id so the child can dereference the
  // original trigger message and read its full content / attachments regardless
  // of whether the user supplied an explicit initialMessage.
  const crossPostExtra = {
    crossPost: {
      sourceThreadId,
      ...(sourceInvocationId ? { sourceInvocationId } : {}),
      ...(sourceEnvelope.sourceMessageId ? { sourceMessageId: sourceEnvelope.sourceMessageId } : {}),
    },
  };
  // Phase AA (AC-AA6): resolve source cat handle for routing credentials
  const sourceCatHandle = sourceCatId ? (primaryMentionHandleForCatId(sourceCatId) ?? `@${sourceCatId}`) : null;
  if (!router || !invocationQueue || !queueProcessor) {
    if (existingSeed) {
      // We cannot wake a target without dispatch dependencies. Cancel the existing
      // seed so the reconcile loop stops retrying a permanently unwakeable row.
      return cancelExistingSeed(existingSeed, messageStore, 'routing dependencies unavailable');
    }
    const enrichedFallback = enrichWithParentThreadHeader(
      seedContent,
      sourceThreadId,
      sourceThreadTitle,
      preferredCats,
      rawInitialMessage,
      null,
      primaryMentionHandleForCatId,
      reportingMode,
      sourceCatHandle,
      declaredWorkMode,
    );
    const stored = await messageStore.append({
      userId,
      catId: sourceCatId ?? null, // AC-AA4: source cat is the message author
      content: enrichedFallback,
      mentions: [],
      timestamp: Date.now(),
      threadId,
      idempotencyKey: `proposal-initial:${proposalId}`,
      deliveryStatus: 'queued',
      extra: crossPostExtra, // AC-AA5: crossPost metadata
      contentBlocks: sourceContentBlocks,
    });
    const delivered = await messageStore.markDelivered(stored.id, Date.now());
    return {
      messageId: stored.id,
      warning:
        delivered?.deliveryStatus === 'delivered'
          ? 'initialMessage dispatch skipped: routing dependencies unavailable'
          : 'initialMessage dispatch skipped: routing dependencies unavailable (delivery mark failed)',
    };
  }

  // Router resolve + parseIntent BOTH read raw (round-2/3 P2 — server-injected
  // header text must NOT leak into the @-mention persist boundary).
  // #1387: routing/intent only consume the explicit user-typed initialMessage.
  // The source envelope (title/reason) is seed content only; it must not carry
  // @-mention or #tag control signals.
  const resolved = await router.resolveTargetsAndIntent(routingInput, threadId, { persist: false });
  const parsed = parseIntent(routingInput, preferredCats?.length ?? resolved.targetCats.length);

  const { targetCats, intentName } = computeDispatchPlan(parsed, resolved.targetCats, preferredCats);
  const parallelReporterHandle = computeParallelReporterHandle(parsed, resolved.targetCats, preferredCats);

  // Build the full enqueued+stored content: parent thread header + mode-aware
  // report-back rule + (serial only) chain protocol. dispatch is the single
  // owner of this pipeline; routes only pass raw + parent metadata.
  const content = enrichWithParentThreadHeader(
    seedContent,
    sourceThreadId,
    sourceThreadTitle,
    preferredCats,
    rawInitialMessage,
    parallelReporterHandle,
    primaryMentionHandleForCatId,
    reportingMode,
    sourceCatHandle, // Phase AA (AC-AA6): routing credentials
    declaredWorkMode,
  );

  if (targetCats.length === 0) {
    if (existingSeed) {
      // No resolvable target for an existing seed: cancel it so the invariant
      // stays terminal and retries do not loop.
      return cancelExistingSeed(existingSeed, messageStore, 'no target cats resolved');
    }
    const stored = await messageStore.append({
      userId,
      catId: sourceCatId ?? null, // AC-AA4
      content,
      mentions: [],
      timestamp: Date.now(),
      threadId,
      idempotencyKey: `proposal-initial:${proposalId}`,
      deliveryStatus: 'queued',
      extra: crossPostExtra, // AC-AA5
      contentBlocks: sourceContentBlocks,
    });
    const delivered = await messageStore.markDelivered(stored.id, Date.now());
    return {
      messageId: stored.id,
      warning:
        delivered?.deliveryStatus === 'delivered'
          ? 'initialMessage dispatch skipped: no target cats resolved'
          : 'initialMessage dispatch skipped: no target cats resolved (delivery mark failed)',
    };
  }

  return executeQueuedDispatch({
    proposalId,
    userId,
    ownerAuthProvenance,
    threadId,
    content,
    targetCats,
    intentName,
    sourceCatId,
    crossPostExtra,
    sourceContentBlocks,
    messageStore,
    threadStore,
    socketManager,
    invocationQueue,
    queueProcessor,
    existingSeed,
  });
}
