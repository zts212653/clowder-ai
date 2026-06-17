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
 *
 * F128 Phase Y: report-back behaviour is now driven by `reportingMode`
 * (none / final-only / state-transitions / blocking-ack), ORTHOGONAL to the
 * `#ideate` wake dimension (C-Y6).
 *
 * Phase AA supersedes Phase Y default: `final-only` is the new default
 * (AC-AA1). Report-back headers now include routing credentials — threadId +
 * targetCats/handle — so cats know WHERE to cross-post and WHO to wake
 * (AC-AA6/AA7).
 */

import type { CatId, ReportingMode } from '@cat-cafe/shared';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import { primaryMentionHandleForCatId } from '../utils/cat-mention-handle.js';

// F128 Phase Y: the `ReportingMode` type lives in @cat-cafe/shared so the
// ThreadProposal record can carry the field end-to-end (propose → store →
// approve dispatch → enrich). This module owns the default.
/**
 * Default reporting mode when a proposal does not specify one.
 * Phase AA (AC-AA1) supersedes Phase Y (AC-Y6): `final-only` is the common
 * case ("做完把结果带回来"). `none` remains as explicit opt-in for
 * autonomous/triage/分发 scenarios.
 */
export const DEFAULT_REPORTING_MODE: ReportingMode = 'final-only';

/**
 * Build the report-back protocol lines for a given reporting mode.
 *
 * ORTHOGONAL to wake mode (C-Y6): `isParallelMode` only changes WHO carries the
 * reporter role (the parallel reporter owner vs. the serial last cat). WHETHER
 * to report at all is `mode`'s decision alone — `#ideate + none` names no owner.
 */
function buildReportingProtocol(
  mode: ReportingMode,
  isParallelMode: boolean,
  reporterHandle: string | null,
  sourceThreadId: string,
  sourceCatHandle: string | null,
): string[] {
  // AC-AA6/AA7: routing credentials line — shared by all modes that mention
  // cross-post. Tells cats exactly where to send and whom to wake.
  // P1-3 fix: emit COPYABLE routing — derive catId from handle (strip @) so
  // targetCats contains a real value, not a placeholder ["..."].
  const sourceCatId = sourceCatHandle?.replace(/^@/, '') ?? null;
  const routingLine = sourceCatId
    ? `**路由目标**：\`cat_cafe_cross_post_message(threadId: "${sourceThreadId}", targetCats: ["${sourceCatId}"])\` 或 content 行首 \`${sourceCatHandle}\`，确保源猫被唤醒。`
    : `**路由目标**：\`cat_cafe_cross_post_message(threadId: "${sourceThreadId}")\`，并在 content 行首 \`@\` 源猫 handle 或设置 \`targetCats\` 确保源猫被唤醒。`;

  switch (mode) {
    case 'none':
      return [
        '**回报模式：autonomous（无强制回报）** — 本 Thread 自治推进，源 Thread 不默认持有回执责任。',
        // AC-AA7: even voluntary cross-posts need routing credentials
        `遇 operator 决策 / 阻塞 / 不可逆操作 / 跨 feature 冲突 / 共享文件争用，仍按家规主动用 \`cat_cafe_cross_post_message\` 上报（"无强制回报"≠"禁止上报"）。上报时必须携带 targetCats 或行首 @ 源猫 handle 确保消息被接收。`,
        routingLine,
      ];
    case 'final-only':
      if (isParallelMode && reporterHandle) {
        return [
          `**回报模式：final-only（并行）report-back owner**：${reporterHandle}（提议顺序第一棒）负责综合所有并行回复，用 \`cat_cafe_cross_post_message\` 把**最终总结**回报到主 Thread（一次）。`,
          '其它并行的猫独立思考 / 回复即可，**不要**各自 cross-post（由 report-back owner 统一汇总）。',
          routingLine,
        ];
      }
      return [
        '**回报模式：final-only** — 完成后由最后一棒猫用 `cat_cafe_cross_post_message` 把**最终总结**回报到主 Thread（一次；中途不必逐步回报）。',
        routingLine,
      ];
    case 'state-transitions':
      if (isParallelMode && reporterHandle) {
        return [
          `**回报模式：state-transitions（并行）report-back owner**：${reporterHandle}（第一棒）负责在每个 phase boundary（阶段完成 / 重要决策 / 状态切换）用 \`cat_cafe_cross_post_message\` 回报主 Thread。`,
          '其它并行的猫独立回复，由 report-back owner 统一汇总状态。',
          routingLine,
        ];
      }
      return [
        '**回报模式：state-transitions** — 在每个 phase boundary（阶段完成 / 重要决策 / 状态切换）用 `cat_cafe_cross_post_message` 回报主 Thread。',
        routingLine,
      ];
    case 'blocking-ack':
      return [
        '**回报模式：blocking-ack** — 遇阻塞点必须等主 Thread ack 才能继续：发 `[BLOCKING]` 请求到主 Thread，并在本 Thread 调 `cat_cafe_hold_ball` 等 ack / 超时。',
        '持球在**本（下游）Thread**，主 Thread 不背轮询责任；非阻塞推进无需逐步回报。',
        routingLine,
      ];
  }
}

/**
 * Resolve the report-back owner handle (C-Y6).
 *
 * An owner is named ONLY for modes that have one (final-only / state-transitions)
 * AND only in parallel mode. `none` / `blocking-ack`, or any serial chain, name
 * none here — so `#ideate + none` injects no reporter.
 */
function resolveReporterHandle(
  isParallelMode: boolean,
  reportingMode: ReportingMode,
  parallelReporterHandle: string | null | undefined,
  preferredCats: readonly CatId[] | undefined,
  resolveHandle: (token: string) => string | null,
): string | null {
  const needsOwner = reportingMode === 'final-only' || reportingMode === 'state-transitions';
  if (!isParallelMode || !needsOwner) {
    return null;
  }
  if (parallelReporterHandle) {
    return parallelReporterHandle;
  }
  if (preferredCats && preferredCats.length > 0) {
    return resolveHandle(preferredCats[0]) ?? `@${preferredCats[0]}`;
  }
  return null;
}

/**
 * Build the serial cat-driven "接力链路" chain protocol section. The report-back
 * tail ("→ 回到主 Thread" + final cross-post step) is suppressed under `none`
 * (C-Y5): autonomous threads do not return to the source thread by default.
 */
function buildChainProtocol(
  preferredCats: readonly CatId[],
  reportingMode: ReportingMode,
  resolveHandle: (token: string) => string | null,
  sourceCatHandle: string | null,
): string[] {
  const handles = preferredCats.map((catId) => resolveHandle(catId) ?? `@${catId}`);
  const chainOrder = handles.join(' → ');
  const isNone = reportingMode === 'none';
  const chainTail = isNone ? '' : ' → 回到主 Thread';
  // AC-AA6: serial chain final step includes routing credentials (P1-3: copyable, not placeholder)
  const sourceCatId = sourceCatHandle?.replace(/^@/, '') ?? null;
  const routingHint = sourceCatId
    ? `（\`targetCats: ["${sourceCatId}"]\` 或行首 \`${sourceCatHandle}\`）`
    : '（设置 `targetCats` 或行首 `@` 源猫 handle）';
  const finalStep = isNone
    ? '  - （本 Thread 为 autonomous 模式，无强制回报；接力完成即可）'
    : `  - 最后一棒完成后, 用 \`cat_cafe_cross_post_message\` 把总结回报到主 Thread${routingHint}`;
  return [
    '',
    '## 接力链路（cat-driven @-chain）',
    `顺序: ${chainOrder}${chainTail}`,
    'Server 只 wake 了**第一棒**。你接到这条消息后:',
    '  - 完成你的回合',
    '  - 在自己回复的**行首独立一行** `@` 下一棒猫的 stable handle 把球传出去',
    finalStep,
    '',
    // NOTE: do NOT write the literal "#ideate" string here — parseIntent
    // would otherwise read this server-injected explanation as an explicit
    // user tag and force parallel mode. Refer to the tool description for
    // the actual opt-in syntax.
    '（如果要**并行模式**让大家独立思考不按顺序，下一次 propose 时按 `cat_cafe_propose_thread` 工具描述里的 ideate 选项 opt-in。）',
  ];
}

/**
 * Inject the "## 主 Thread" header (parent thread pointer + reporting protocol
 * + cat-driven chain protocol) into the first sub-thread message.
 *
 * - Header is appended to the END of the user-typed content so it doesn't
 *   visually break the user's opening (greeting / game rules / topic intro).
 * - Reporting protocol is driven by `reportingMode` (F128 Phase Y), ORTHOGONAL
 *   to the wake dimension: a reporter owner is named only for modes that have
 *   one AND only in parallel (`#ideate`) mode (C-Y6).
 * - Chain protocol section ("接力链路") is injected only in serial mode; its
 *   report-back tail ("→ 回到主 Thread") is suppressed under `none` (C-Y5).
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
  reportingMode: ReportingMode = DEFAULT_REPORTING_MODE,
  /** Phase AA (AC-AA6): stable handle of the source cat for routing credentials. */
  sourceCatHandle?: string | null,
): string {
  let isParallelMode = false;
  if (rawInitialMessage) {
    const parsed = parseIntent(rawInitialMessage, preferredCats?.length ?? 0);
    isParallelMode = parsed.explicit && parsed.intent === 'ideate';
  }
  const reporterHandle = resolveReporterHandle(
    isParallelMode,
    reportingMode,
    parallelReporterHandle,
    preferredCats,
    resolveHandle,
  );

  const titleLine = sourceThreadTitle ? `\n标题: ${sourceThreadTitle}` : '';
  const headerLines: string[] = ['---', '## 主 Thread', `ID: \`${sourceThreadId}\`${titleLine}`, ''];

  // Report-back section: orthogonal to wake mode, driven by reportingMode (C-Y6).
  // Phase AA: routing credentials (sourceThreadId + sourceCatHandle) injected into
  // all modes so cats know exactly where and whom to cross-post to (AC-AA6/AA7).
  headerLines.push(
    ...buildReportingProtocol(reportingMode, isParallelMode, reporterHandle, sourceThreadId, sourceCatHandle ?? null),
  );

  // Chain protocol section: wake dimension, serial only (C-Y5 tail handled inside).
  if (!isParallelMode && preferredCats && preferredCats.length > 0) {
    headerLines.push(...buildChainProtocol(preferredCats, reportingMode, resolveHandle, sourceCatHandle ?? null));
  }

  return `${content}\n\n${headerLines.join('\n')}`;
}
