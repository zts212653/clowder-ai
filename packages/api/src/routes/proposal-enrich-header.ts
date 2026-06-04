/**
 * F128 enrichment helper — builds the "## 主 Thread" header that the
 * thread-orchestration skill mandates for the first message of any
 * sub-thread.
 *
 * Split out of proposal-approve-dispatch.ts (round-9 plan-based refactor)
 * to honor the AC-X1 ≤350-line file cap and to give the enrichment
 * pipeline its own readable unit. dispatch is the sole caller in
 * production; the function stays exported so unit tests / future
 * callers can build the header directly with an explicit reporter.
 */

import type { CatId } from '@cat-cafe/shared';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import { primaryMentionHandleForCatId } from '../utils/cat-mention-handle.js';

/**
 * Inject the "## 主 Thread" header (parent thread pointer + report-back
 * rule + cat-driven chain protocol) into the first sub-thread message.
 *
 * - Header is appended to the END of the user-typed content so it doesn't
 *   visually break the user's opening (greeting / game rules / topic intro).
 * - Report-back rule is MODE-AWARE: serial chain uses "last cat" implicit
 *   owner; explicit `#ideate` parallel uses the caller-supplied
 *   `parallelReporterHandle` (computed from a router-resolved canonical
 *   catId — see dispatch reporter resolution).
 * - Chain protocol section ("接力链路") is injected only in serial mode.
 *
 * Mode is detected from `rawInitialMessage` (NEVER from `content` —
 * server-injected text could contain literal `#ideate` from parent title
 * and trip parseIntent's `#tag` regex; see round-2/3 P2 footguns).
 */
export function enrichWithParentThreadHeader(
  content: string,
  sourceThreadId: string,
  sourceThreadTitle?: string | null,
  preferredCats?: readonly CatId[],
  rawInitialMessage?: string,
  parallelReporterHandle?: string | null,
  resolveHandle: (token: string) => string | null = primaryMentionHandleForCatId,
): string {
  let isParallelMode = false;
  if (rawInitialMessage) {
    const parsed = parseIntent(rawInitialMessage, preferredCats?.length ?? 0);
    isParallelMode = parsed.explicit && parsed.intent === 'ideate';
  }
  let reporterHandle: string | null = null;
  if (isParallelMode) {
    if (parallelReporterHandle) {
      reporterHandle = parallelReporterHandle;
    } else if (preferredCats && preferredCats.length > 0) {
      reporterHandle = resolveHandle(preferredCats[0]) ?? `@${preferredCats[0]}`;
    }
  }

  const titleLine = sourceThreadTitle ? `\n标题: ${sourceThreadTitle}` : '';
  const headerLines: string[] = ['---', '## 主 Thread', `ID: \`${sourceThreadId}\`${titleLine}`, ''];

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
