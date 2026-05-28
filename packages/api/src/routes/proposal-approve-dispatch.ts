import type { CatId } from '@cat-cafe/shared';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';

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
  content: string;
  /**
   * Optional fallback targets. When the router cannot resolve any @-mention in
   * `content` (typical case: user wrote "开玩！" as initialMessage without
   * @-ing the proposed members), we fall back to the proposal's preferredCats
   * so all proposed members get woken up — that's the whole point of
   * choosing them on the proposal card.
   */
  preferredCats?: readonly CatId[];
  messageStore: IMessageStore;
}

export interface AppendApprovedInitialMessageResult {
  messageId: string;
  warning?: string;
}

/**
 * Build the "## 主 Thread" header that the thread-orchestration skill mandates
 * for the first message of any sub-thread. This header lets cats inside the
 * sub-thread locate the parent thread and report back when work is done
 * (skill Step 5c "汇聚" — final report flow).
 *
 * F128: cats sometimes forget to include this header when writing
 * `initialMessage` on the proposal card. Server injects it defensively at
 * approve time so the fork-and-return loop never breaks on cat omission.
 *
 * The header is appended to the END of the user-typed content (rather than
 * prepended) so it doesn't visually break the user's opening (greeting /
 * game rules / topic intro). Cats reading the thread bottom-up still pick
 * it up reliably because it stays in the first message.
 */
export function enrichWithParentThreadHeader(
  content: string,
  sourceThreadId: string,
  sourceThreadTitle?: string | null,
): string {
  const titleLine = sourceThreadTitle ? `\n标题: ${sourceThreadTitle}` : '';
  const header = [
    '---',
    '## 主 Thread',
    `ID: \`${sourceThreadId}\`${titleLine}`,
    '',
    '完成后请由最后一棒猫 `cat_cafe_cross_post_message` 把总结回报到这个主 Thread。',
    '（这是 thread-orchestration skill 的 Step 5c 汇聚铁律，不要忘了汇报。）',
  ].join('\n');
  return `${content}\n\n${header}`;
}

export async function appendApprovedInitialMessage({
  proposalId,
  userId,
  threadId,
  content,
  preferredCats,
  messageStore,
  router,
  invocationQueue,
  queueProcessor,
}: AppendApprovedInitialMessageInput): Promise<AppendApprovedInitialMessageResult> {
  if (!router || !invocationQueue || !queueProcessor) {
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
      warning: 'initialMessage dispatch skipped: routing dependencies unavailable',
    };
  }

  const resolved = await router.resolveTargetsAndIntent(content, threadId, { persist: true });
  const parsed = parseIntent(content, preferredCats?.length ?? resolved.targetCats.length);

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
  let targetCats: readonly CatId[];
  let intentName: string;
  if (parsed.explicit && parsed.intent === 'ideate') {
    targetCats =
      preferredCats && preferredCats.length > 0 ? preferredCats : resolved.targetCats;
    intentName = 'ideate';
  } else {
    const firstCandidate = preferredCats?.[0] ?? resolved.targetCats[0];
    targetCats = firstCandidate ? [firstCandidate] : [];
    intentName = 'execute';
  }

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
