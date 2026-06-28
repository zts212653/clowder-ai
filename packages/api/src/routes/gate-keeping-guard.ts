/**
 * F167 trigger-time gate-keeping thread guard.
 *
 * Root cause: opensource-ops SKILL.md 文字层 100%「守门 thread 不修 bug / 不替下游
 * hold」但 trigger-time 0 enforcement → 同 session 同天 2 只猫连续在守门 thread
 * 误挂 PR tracking + hold_ball（双 owner，球权死锁）。
 *
 * Guard 行为：当 thread.threadKind === 'gate-keeping' 时，对三个端点实施策略：
 *   - `register_pr_tracking` → 始终 hard-block（PR tracking 必须在下游 thread）
 *   - `register_issue_tracking` → 结构化允许：仅当 issueOwnership === 'keeper'
 *     （gate-keeper 追踪自己守门职责范围内的 issue，如等 reporter 回复 needs-info）
 *   - `hold_ball` → 结构化允许：仅当短 SLA（≤ SHORT_SLA_THRESHOLD_MS）且无
 *     事件回调覆盖（no PR/issue tracking 已注册同线程）
 *
 * Phase N 原始设计: 一刀切 block 三个端点。
 * PR-O3 policy patch: 替换 issue_tracking + hold_ball 为结构化允许。
 * 不变: register_pr_tracking 始终 block + override 通道始终不存在。
 *
 * Fail-open 原则：threadStore.get 抛错（Redis 抖动 / store 未注入）→ 不阻塞生产。
 */

import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { CALLBACK_TOOL, STATUS } from '../infrastructure/telemetry/genai-semconv.js';
import { gateKeepingHarnessAttemptCount } from '../infrastructure/telemetry/instruments.js';

/**
 * Minimal counter shape — accepts whatever instruments.ts exposes (lazy
 * OpenTelemetry counter). Kept structural so test stubs can inject a fake.
 *
 * Attribute keys map to the F152 metric-allowlist:
 *   tool → CALLBACK_TOOL ('callback.tool')
 *   outcome → STATUS ('status')
 */
export interface GateKeepingMetricCounter {
  add(value: number, attributes: Record<string, string>): void;
}

export type GateKeepingTool = 'register_pr_tracking' | 'register_issue_tracking' | 'hold_ball';

export type GateKeepingOutcome = 'pass' | 'blocked' | 'guard_skipped' | 'allowed_by_policy';

/**
 * PR-O3: Short-SLA threshold for hold_ball in gate-keeping threads.
 * Holds ≤ this duration are allowed when no event callback covers the wait.
 * Holds > this duration are blocked (push to sweep / needs-info cycle).
 *
 * 10 minutes — covers operational holds (checking 👀 reaction, waiting
 * for a quick CI result) but blocks long waits that should be sweep tasks.
 */
export const SHORT_SLA_THRESHOLD_MS = 600_000;

function metricAttributes(tool: GateKeepingTool, outcome: GateKeepingOutcome): Record<string, string> {
  return { [CALLBACK_TOOL]: tool, [STATUS]: outcome };
}

export interface GateKeepingGuardResult {
  outcome: GateKeepingOutcome;
  /** 当 outcome === 'blocked' 时填充：路由层应 return 这个 body + status 400。 */
  blockedResponse?: {
    error: 'gate_keeping_thread_default_blocked';
    reason: string;
    remediation: string;
    threadKind: 'gate-keeping';
    tool: GateKeepingTool;
  };
}

/**
 * PR-O3: Policy context for nuanced gate-keeping decisions.
 *
 * Without policyContext, the guard falls back to the Phase N default
 * (block all three tools). This preserves backward compatibility and
 * ensures fail-safe: a caller that doesn't pass context gets blocked.
 */
export interface GateKeepingPolicyContext {
  /**
   * For register_issue_tracking: who owns this issue in the current context?
   * - 'keeper': gate-keeper tracks its own issue (gatekeeper-needs-info pattern)
   * - 'distributed': issue belongs to a downstream thread
   *
   * Default (not provided) → treated as distributed → blocked.
   *
   * PR-O4: Now independently verified via cross-store query.
   * verifyKeeperOwnership() in gate-keeping-cross-store.ts checks TaskStore
   * for existing tracking of the same issue subject: same-thread → keeper,
   * different-thread → distributed, no existing → new registration → keeper.
   * Caller no longer declares ownership — it's derived from store truth.
   */
  issueOwnership?: 'keeper' | 'distributed';

  /**
   * For hold_ball: wake-up delay in milliseconds.
   * Used to determine short-SLA (≤ SHORT_SLA_THRESHOLD_MS) vs long/unbounded.
   */
  wakeAfterMs?: number;

  /**
   * For hold_ball: whether a structured event callback already covers this wait.
   * True when PR tracking or issue tracking is registered in the same thread
   * and will auto-wake the cat when the condition is met.
   *
   * Event-backed holds are blocked because they're redundant.
   */
  hasEventCallback?: boolean;

  /**
   * PR-O4: For hold_ball: whether a structured waitSourceRef was provided.
   * Gate-keeping threads require grounded waits — a short-SLA hold without
   * waitSourceRef is ungrounded and gets blocked.
   *
   * Per spec L926: "仅当 keeper-owned + 无 event callback + 短 SLA + waitSourceRef 允许"
   * This closes the gap between the SLA-based proxy and the full narrow gate.
   */
  hasWaitSourceRef?: boolean;
}

export interface CheckGateKeepingInput {
  threadStore: Pick<IThreadStore, 'get'> | undefined;
  threadId: string;
  tool: GateKeepingTool;
  /** 可选 telemetry counter；caller 不传默认用 registered counter。 */
  metric?: GateKeepingMetricCounter;
  /** 可选 logger（warn 级，用于 guard_skipped）。 */
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  /** 透传 telemetry 上下文（catId / 端点参数），用于 log。 */
  context?: Record<string, unknown>;
  /** PR-O3: policy context for nuanced allow/block decisions in gate-keeping threads. */
  policyContext?: GateKeepingPolicyContext;
}

const REMEDIATION_PR =
  '请先 cross_post_message 到 PR 的负责 thread 或 propose_thread 开新 thread 把球分发，再在下游 thread 调本工具。守门 thread 没有 override 通道。';
const REMEDIATION_ISSUE =
  '请先 cross_post_message 到 issue 的负责 thread 或 propose_thread 开新 thread 把球分发，再在下游 thread 调本工具。守门 thread 没有 override 通道。';
const REMEDIATION_HOLD =
  '请先 cross_post_message / propose_thread 把球完整分发给下游 thread，让下游 thread 自己 hold；守门 thread 不替下游 hold（opensource-ops SKILL Common Mistakes #8）。';
const REMEDIATION_HOLD_EVENT_BACKED =
  'PR tracking 或 issue tracking 已注册在当前 thread，事件回调会自动唤醒。额外 hold_ball 是冗余的——移除 hold，等回调。';
const REMEDIATION_HOLD_LONG_SLA =
  '守门 thread 仅允许短期操作性 hold（≤10分钟）。长时间等待请用 sweep task 或 cross_post 给下游 thread 分发后再 hold。';
const REMEDIATION_HOLD_UNGROUNDED =
  '守门 thread 要求结构化 wait：请在 hold_ball 请求中提供 waitSourceRef（指向 GitHub issue/comment/reporter SLA）。无 waitSourceRef 的 hold 是 ungrounded 的。';

const REASON_PR =
  '守门 thread 默认不挂 PR tracking——把球 cross_post 或 propose_thread 给下游 owner（opensource-ops SKILL 红线）';
const REASON_ISSUE =
  '守门 thread 默认不挂 issue tracking——把球 cross_post 或 propose_thread 给下游 owner（opensource-ops SKILL 红线）';
const REASON_HOLD =
  '守门 thread 默认不挂 hold_ball——已 cross_post / propose 分发后不再替下游 hold（opensource-ops SKILL Common Mistakes #8）';

function reasonFor(tool: GateKeepingTool): string {
  switch (tool) {
    case 'register_pr_tracking':
      return REASON_PR;
    case 'register_issue_tracking':
      return REASON_ISSUE;
    case 'hold_ball':
      return REASON_HOLD;
  }
}

function remediationFor(tool: GateKeepingTool): string {
  switch (tool) {
    case 'register_pr_tracking':
      return REMEDIATION_PR;
    case 'register_issue_tracking':
      return REMEDIATION_ISSUE;
    case 'hold_ball':
      return REMEDIATION_HOLD;
  }
}

/**
 * Trigger-time guard. Returns:
 *   - `pass` — non-gate-keeping thread; let caller proceed
 *   - `blocked` — gate-keeping thread + policy denies; caller MUST return blockedResponse + 400
 *   - `allowed_by_policy` — gate-keeping thread + policy allows; caller may proceed
 *   - `guard_skipped` — threadStore missing or get() threw; fail-open (telemetry counted)
 *
 * INV-G1 (mutual exclusion): threadKind union ensures concierge XOR gate-keeping XOR undefined.
 * INV-G7 (fail-open): never block on infra flakiness.
 * INV-G8 (PR-O3 default-safe): no policyContext → fall back to Phase N blanket block.
 */
export async function checkGateKeepingGuard(input: CheckGateKeepingInput): Promise<GateKeepingGuardResult> {
  const { threadStore, threadId, tool, log, context = {}, policyContext } = input;
  // Default to the registered counter; callers may inject a stub for testing.
  const metric: GateKeepingMetricCounter = input.metric ?? gateKeepingHarnessAttemptCount;

  if (!threadStore) {
    metric.add(1, metricAttributes(tool, 'guard_skipped'));
    log?.warn({ threadId, tool, ...context }, 'F167 gate-keeping guard skipped: threadStore not configured');
    return { outcome: 'guard_skipped' };
  }

  let threadKind: string | undefined;
  try {
    const thread = await threadStore.get(threadId);
    threadKind = thread?.threadKind;
  } catch (err) {
    metric.add(1, metricAttributes(tool, 'guard_skipped'));
    log?.warn(
      { threadId, tool, err, ...context },
      'F167 gate-keeping guard skipped: threadStore.get failed (fail-open)',
    );
    return { outcome: 'guard_skipped' };
  }

  if (threadKind !== 'gate-keeping') {
    return { outcome: 'pass' };
  }

  // ── PR-O3: per-tool policy in gate-keeping threads ──────────────
  return applyGateKeepingPolicy(tool, policyContext, metric);
}

// ── Internal policy engine ────────────────────────────────────────

function blocked(
  tool: GateKeepingTool,
  reason: string,
  remediation: string,
  metric: GateKeepingMetricCounter,
): GateKeepingGuardResult {
  metric.add(1, metricAttributes(tool, 'blocked'));
  return {
    outcome: 'blocked',
    blockedResponse: {
      error: 'gate_keeping_thread_default_blocked',
      reason,
      remediation,
      threadKind: 'gate-keeping',
      tool,
    },
  };
}

function allowedByPolicy(tool: GateKeepingTool, metric: GateKeepingMetricCounter): GateKeepingGuardResult {
  metric.add(1, metricAttributes(tool, 'allowed_by_policy'));
  return { outcome: 'allowed_by_policy' };
}

function applyGateKeepingPolicy(
  tool: GateKeepingTool,
  policyContext: GateKeepingPolicyContext | undefined,
  metric: GateKeepingMetricCounter,
): GateKeepingGuardResult {
  switch (tool) {
    // ── PR tracking: always blocked ───────────────────────────────
    case 'register_pr_tracking':
      return blocked(tool, reasonFor(tool), remediationFor(tool), metric);

    // ── Issue tracking: allow keeper-owned ─────────────────────────
    case 'register_issue_tracking':
      if (policyContext?.issueOwnership === 'keeper') {
        return allowedByPolicy(tool, metric);
      }
      return blocked(tool, reasonFor(tool), remediationFor(tool), metric);

    // ── Hold ball: allow short-SLA + no callback + grounded ────────
    case 'hold_ball': {
      // Event-backed hold → blocked (redundant, callback will wake)
      if (policyContext?.hasEventCallback) {
        return blocked(tool, '事件回调已注册，hold_ball 冗余', REMEDIATION_HOLD_EVENT_BACKED, metric);
      }
      const sla = policyContext?.wakeAfterMs;
      // Short SLA + grounded (has waitSourceRef) + no callback → allowed
      // Per spec L926: "仅当 keeper-owned + 无 event callback + 短 SLA + waitSourceRef 允许"
      if (sla !== undefined && sla <= SHORT_SLA_THRESHOLD_MS) {
        if (policyContext?.hasWaitSourceRef) {
          return allowedByPolicy(tool, metric);
        }
        // Short SLA but ungrounded (no waitSourceRef) → blocked
        return blocked(
          tool,
          '守门 thread hold 需要结构化 wait 依据（waitSourceRef）',
          REMEDIATION_HOLD_UNGROUNDED,
          metric,
        );
      }
      // Long/unbounded or no context → blocked
      const remediation =
        sla !== undefined && sla > SHORT_SLA_THRESHOLD_MS ? REMEDIATION_HOLD_LONG_SLA : remediationFor(tool);
      return blocked(tool, reasonFor(tool), remediation, metric);
    }
  }
}
