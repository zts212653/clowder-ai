import type { CatId } from '@cat-cafe/shared';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { primaryMentionHandleForCatId } from '../utils/cat-mention-handle.js';

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
   * Content actually enqueued + persisted as the first sub-thread message.
   * Typically pre-enriched by `enrichWithParentThreadHeader` (parent thread
   * pointer + cat-driven chain protocol section).
   */
  content: string;
  /**
   * Raw user-typed initialMessage BEFORE enrichWithParentThreadHeader. Used
   * as the parseIntent source AND as the router.resolveTargetsAndIntent
   * source — NEVER stored or enqueued (enqueue/store continue to use the
   * enriched `content` so cats see the full parent-thread header + chain
   * protocol section). Defaults to `content` for backward compatibility,
   * but callers that pre-enrich MUST pass the raw form, otherwise
   * server-injected text leaks into routing in two ways:
   *
   *   1. parseIntent footgun (砚砚 PR #809 round-2 P2): a parent thread
   *      title containing `#ideate` trips `/#(\w+)/gi` and forces serial
   *      proposals into parallel mode. Reproduced: parent title
   *      `Parent #ideate title` + initialMessage `开玩!` → intent=ideate.
   *
   *   2. router @-mention persistence footgun (砚砚 PR #809 round-3 P2):
   *      `router.resolveTargetsAndIntent(..., { persist: true })` scans
   *      its input for `@-mentions` and persists every hit to thread
   *      participants. A parent thread title `Parent @opus thread` would
   *      silently wake `opus` AND write `opus` into the new sub-thread's
   *      participants whenever the user proposed with `preferredCats=[]`
   *      and no `@` in their initialMessage. Both effects are wrong: the
   *      parent title is server-injected display text, not user intent.
   *
   * dispatch fallback `preferredCats?.[0] ?? resolved.targetCats[0]` only
   * uses resolved.targetCats when preferredCats is empty, but that path
   * exists, so we must close the leak at the router input. router still
   * needs the threadId for context (e.g. existing participants), but the
   * message argument must be the raw user intent only.
   */
  rawContent?: string;
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
  preferredCats?: readonly CatId[],
  rawInitialMessage?: string,
  resolveHandle: (token: string) => string | null = primaryMentionHandleForCatId,
): string {
  // Mode + reporter detection (砚砚 round-5 / 6 / 7 P1).
  // Detection MUST read raw, not enriched `content` (parent title could
  // contain literal `#ideate` and trip the regex — see rawContent jsdoc).
  // Round-7 removed the `preferredCats.length > 0` precondition: dispatch's
  // explicit `#ideate + preferredCats=[]` path wakes `resolved.targetCats`
  // in parallel — same semantics, different target source — and previously
  // fell through to the serial "最后一棒猫" rule.
  // Reporter resolution: preferredCats[0] → raw first `@<token>` fallback
  // (matches the router's first resolved target; cat-side display fidelity
  // since both read the same raw string).
  let isParallelMode = false;
  if (rawInitialMessage) {
    const parsed = parseIntent(rawInitialMessage, preferredCats?.length ?? 0);
    isParallelMode = parsed.explicit && parsed.intent === 'ideate';
  }
  let reporterHandle: string | null = null;
  if (isParallelMode) {
    if (preferredCats && preferredCats.length > 0) {
      reporterHandle = resolveHandle(preferredCats[0]) ?? `@${preferredCats[0]}`;
    } else if (rawInitialMessage) {
      const firstMention = rawInitialMessage.match(/@([\w-]+)/);
      if (firstMention) reporterHandle = `@${firstMention[1]}`;
    }
  }

  const titleLine = sourceThreadTitle ? `\n标题: ${sourceThreadTitle}` : '';
  const headerLines: string[] = ['---', '## 主 Thread', `ID: \`${sourceThreadId}\`${titleLine}`, ''];

  // F128 report-back contract — MODE-AWARE (砚砚 round-6 P1 fix):
  // Default cat-driven chain: "last cat in the chain reports back" — implicit
  // owner determined by the @-mention chain itself.
  // Explicit `#ideate` parallel: there is no "last cat" — every cat replies
  // independently. Without an explicit reporter the fork-and-return loop
  // breaks (no one reports, or everyone duplicates cross_post). Pin
  // preferredCats[0] (card order is ground truth) as the synthesizer +
  // reporter, and tell the other parallel cats NOT to cross_post.
  if (isParallelMode && reporterHandle) {
    headerLines.push(
      `**并行模式 report-back owner**：${reporterHandle}（提议顺序的第一棒）负责综合所有并行回复，用 \`cat_cafe_cross_post_message\` 把总结回报到这个主 Thread。`,
      '其它并行的猫独立思考 / 回复就行，**不要** `cat_cafe_cross_post_message` 自己的回复（避免重复汇报，由 reporter owner 统一汇总）。',
    );
  } else {
    headerLines.push(
      '完成后请由最后一棒猫 `cat_cafe_cross_post_message` 把总结回报到这个主 Thread。',
      '（这是 thread-orchestration skill 的 Step 5c 汇聚铁律，不要忘了汇报。）',
    );
  }

  // F128 chain protocol injection (砚砚 round-1 P1 + round-5 P1):
  // serial mode only — parallel cats are woken simultaneously and would
  // emit redundant handoffs if told to chain. The report-back rule above
  // already handles the parallel fork-and-return owner.
  if (!isParallelMode && preferredCats && preferredCats.length > 0) {
    const handles = preferredCats.map((catId) => resolveHandle(catId) ?? `@${catId}`);
    const chainOrder = handles.join(' → ');
    headerLines.push(
      '',
      '## 接力链路（cat-driven @-chain）',
      `顺序: ${chainOrder} → 回到主 Thread`,
      'Server 只 wake 了**第一棒**。你接到这条消息后:',
      '  - 完成你的回合',
      '  - 在自己回复的**行首独立一行** `@` 下一棒猫的 stable handle 把球传出去',
      '  - 最后一棒完成后, 用 `cat_cafe_cross_post_message` 把总结回报到主 Thread',
      '',
      // NOTE: do NOT write the literal "#ideate" string here — parseIntent
      // would otherwise read this server-injected explanation as an explicit
      // user tag and force parallel mode. Refer to the tool description for
      // the actual opt-in syntax.
      '（如果要**并行模式**让大家独立思考不按顺序，下一次 propose 时按 `cat_cafe_propose_thread` 工具描述里的 ideate 选项 opt-in。）',
    );
  }

  return `${content}\n\n${headerLines.join('\n')}`;
}

export async function appendApprovedInitialMessage({
  proposalId,
  userId,
  threadId,
  content,
  rawContent,
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

  // F128 (砚砚 PR #809 round-2 + round-3 P2): isolate router AND parseIntent
  // inputs to the raw user-typed initialMessage. Enqueue/store still use the
  // enriched content below so cats see the full "## 主 Thread" + chain
  // protocol section. See AppendApprovedInitialMessageInput.rawContent
  // jsdoc for the full footgun catalogue.
  //   - parseIntent: must not see `#ideate` from parent title
  //   - router.resolveTargetsAndIntent(persist=true): must not write
  //     parent-title `@cat` mentions into the new sub-thread participants
  //     and must not feed dispatch fallback (preferredCats=[] path).
  const intentSource = rawContent ?? content;
  const resolved = await router.resolveTargetsAndIntent(intentSource, threadId, { persist: true });
  const parsed = parseIntent(intentSource, preferredCats?.length ?? resolved.targetCats.length);

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
