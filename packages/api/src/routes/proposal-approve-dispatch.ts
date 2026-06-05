import type { CatId, ReportingMode } from '@cat-cafe/shared';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { primaryMentionHandleForCatId } from '../utils/cat-mention-handle.js';
import { enrichWithParentThreadHeader } from './proposal-enrich-header.js';

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
  rawInitialMessage: string;
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
  /** F128 Phase Y: reporting mode from the proposal record (undefined → enrich default none, AC-Y6). */
  reportingMode?: ReportingMode;
  messageStore: IMessageStore;
}

export interface AppendApprovedInitialMessageResult {
  messageId: string;
  warning?: string;
}

export async function appendApprovedInitialMessage({
  proposalId,
  userId,
  threadId,
  rawInitialMessage,
  sourceThreadId,
  sourceThreadTitle,
  preferredCats,
  reportingMode,
  messageStore,
  router,
  invocationQueue,
  queueProcessor,
}: AppendApprovedInitialMessageInput): Promise<AppendApprovedInitialMessageResult> {
  if (!router || !invocationQueue || !queueProcessor) {
    const enrichedFallback = enrichWithParentThreadHeader(
      rawInitialMessage,
      sourceThreadId,
      sourceThreadTitle,
      preferredCats,
      rawInitialMessage,
      null,
      primaryMentionHandleForCatId,
      reportingMode,
    );
    const stored = await messageStore.append({
      userId,
      catId: null,
      content: enrichedFallback,
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    return {
      messageId: stored.id,
      warning: 'initialMessage dispatch skipped: routing dependencies unavailable',
    };
  }

  // Router resolve + parseIntent BOTH read raw (round-2/3 P2 — server-injected
  // header text must NOT leak into the @-mention persist boundary).
  const resolved = await router.resolveTargetsAndIntent(rawInitialMessage, threadId, { persist: true });
  const parsed = parseIntent(rawInitialMessage, preferredCats?.length ?? resolved.targetCats.length);

  // F128 dispatch model — "他们自己决定下一个要把谁叫出来" (owner-defined, 2026-05-27):
  //
  // Default behaviour: wake ONLY the first cat. Subsequent turns are driven by
  // cat-side @-mentions in the chain (the first cat reads initialMessage,
  // sees the order/rules, and @s the next cat; that cat does the same).
  // Dispatch does NOT pre-fire all proposedCats — that would scramble
  // ordering and force a parallel race where the user wants a chain (接龙
  // / 轮转 / 讨论).
  //
  // First-cat preference:
  //   1. preferredCats[0] — the card's first picked member is the narrative
  //      intent ("you chose them, in this order, the first one starts").
  //   2. router-resolved first mention — fallback when preferredCats is empty
  //      but the message text @-mentions someone.
  //
  // Explicit #ideate escape hatch: if the user really wants parallel
  // ideation (everyone replies independently at once), they tag #ideate in
  // the initialMessage. That brings back the legacy "wake all" behaviour.
  //
  // 砚砚 round-5 P2 escape hatch: explicit #execute + no preferredCats +
  // raw text @-mentions multiple cats means the user is asking for serial
  // multi-cat execution (the F088 router contract for #execute outside
  // F128). Silently collapsing to the first target would discard explicit
  // user intent. preferredCats non-empty still wins (card order is ground
  // truth — first-cat chain starter), but preferredCats=[] + explicit
  // #execute should preserve all router-resolved targets.
  let targetCats: readonly CatId[];
  let intentName: string;
  if (parsed.explicit && parsed.intent === 'ideate') {
    targetCats = preferredCats && preferredCats.length > 0 ? preferredCats : resolved.targetCats;
    intentName = 'ideate';
  } else if (
    parsed.explicit &&
    parsed.intent === 'execute' &&
    (!preferredCats || preferredCats.length === 0) &&
    resolved.targetCats.length > 0
  ) {
    targetCats = resolved.targetCats;
    intentName = 'execute';
  } else {
    const firstCandidate = preferredCats?.[0] ?? resolved.targetCats[0];
    targetCats = firstCandidate ? [firstCandidate] : [];
    intentName = 'execute';
  }

  // Round-9 plan-based reporter resolution: compute canonical reporter
  // handle from the router-resolved catId (not raw token regex). This
  // closes the round-7/8 補锅匠 trap — primaryMentionHandleForCatId
  // returns the catRegistry-configured primary handle regardless of how
  // the user wrote the raw mention (CJK / dotted / hyphenated all work).
  let parallelReporterHandle: string | null = null;
  if (parsed.explicit && parsed.intent === 'ideate') {
    const reporterCatId = preferredCats?.[0] ?? resolved.targetCats[0];
    if (reporterCatId) {
      parallelReporterHandle = primaryMentionHandleForCatId(reporterCatId) ?? `@${reporterCatId}`;
    }
  }

  // Build the full enqueued+stored content: parent thread header + mode-aware
  // report-back rule + (serial only) chain protocol. dispatch is the single
  // owner of this pipeline; routes only pass raw + parent metadata.
  const content = enrichWithParentThreadHeader(
    rawInitialMessage,
    sourceThreadId,
    sourceThreadTitle,
    preferredCats,
    rawInitialMessage,
    parallelReporterHandle,
    primaryMentionHandleForCatId,
    reportingMode,
  );

  if (targetCats.length === 0) {
    const stored = await messageStore.append({
      userId,
      catId: null,
      content,
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    return {
      messageId: stored.id,
      warning: 'initialMessage dispatch skipped: no target cats resolved',
    };
  }

  const enqueueResult = invocationQueue.enqueue({
    threadId,
    userId,
    idempotencyKey: `proposal-initial:${proposalId}`,
    content,
    source: 'user',
    targetCats: targetCats as CatId[],
    intent: intentName,
  });

  if (enqueueResult.outcome === 'full' || !enqueueResult.entry) {
    const stored = await messageStore.append({
      userId,
      catId: null,
      content,
      mentions: [...targetCats],
      timestamp: Date.now(),
      threadId,
    });
    return {
      messageId: stored.id,
      warning: 'initialMessage dispatch skipped: queue is full',
    };
  }

  let storedMessageId = enqueueResult.entry.messageId ?? null;
  if (!enqueueResult.deduped || !storedMessageId) {
    try {
      const stored = await messageStore.append({
        userId,
        catId: null,
        content,
        mentions: [...targetCats],
        timestamp: Date.now(),
        threadId,
        idempotencyKey: `proposal-initial:${proposalId}`,
        deliveryStatus: 'queued',
      });
      storedMessageId = stored.id;
      invocationQueue.backfillMessageId(threadId, userId, enqueueResult.entry.id, stored.id);
    } catch (err) {
      invocationQueue.rollbackEnqueue(threadId, userId, enqueueResult.entry.id);
      throw err;
    }
  }

  try {
    const started = await queueProcessor.processNext(threadId, userId);
    if (!started.started) {
      return {
        messageId: storedMessageId,
        warning: 'initialMessage queued but did not start automatically',
      };
    }
  } catch (err) {
    return {
      messageId: storedMessageId,
      warning: `initialMessage queued but auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { messageId: storedMessageId };
}
