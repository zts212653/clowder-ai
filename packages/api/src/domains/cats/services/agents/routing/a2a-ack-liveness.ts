/**
 * LI-005 Phase 1 — A2A Ack Liveness Detection (接球执行触发存活性检测).
 *
 * 检测猫通过 A2A 接到球后（inline @mention 或 queue-dispatched），invocation 结束时
 * 既无路由出口（行首 @mention / @co-creator / structured routing）也无持久触发器
 * （hold_ball / register_scheduled_task / register_pr_tracking /
 * register_issue_tracking / community_await_external），导致球静默死亡——
 * 无机制保证后续执行。
 *
 * Phase 1 scope: detection + hint + observability（ball.void_ack 事件 + telemetry）。
 * Phase 2（structural rejection / auto-wake）待 Phase 1 收集数据后实施。
 *
 * 声明-动作一致性检查的延伸：void-hold 查"说持球没做"，
 * ack-liveness 查"接了球没绑触发器"。
 *
 * A2A 路径信号（isA2AInvocation）:
 *   - inline serial: `directMessageFrom`（routeSerial a2aFrom map 中 catId）
 *   - queue-dispatched: `queueTriggerReplyTo`（derived from `a2aTriggerMessageId` in options）
 * `a2aTriggerMessageId` 已确认为 **cat→cat 专属**——5 个赋值点全部在 A2A 路径
 * （callback-a2a-trigger.ts 3 处 + route-serial.ts inline/deferred 2 处），
 * 0 个 operator/user/connector 路径设置此字段。operator 发起的 invocation
 * 不会被误判为 A2A。详见 Fable ① 核验（2026-07-16 Explore agent 穷举确认）。
 *
 * 纯函数、零 IO、可测。
 *
 * @see void-hold-detect.ts — 同族守卫，模式参照
 * @see docs/features/assets/li005-ack-liveness/live-candidates-2026-07-14.md — LI-005 定义
 */

/**
 * Tool names that constitute a "durable trigger" — calling any one of these
 * means the cat bound a mechanism that will ensure future execution.
 *
 * Criteria: the tool MUST register a system mechanism (timer, webhook, cron)
 * that will invoke the cat in the future. Pure bookkeeping tools (create_task)
 * do NOT qualify — they create visible panel items but have no invokeTrigger
 * or scheduled wake.
 *
 * Order doesn't matter (Set-based lookup). The list uses suffix matching
 * to cover both `mcp__cat-cafe-collab__cat_cafe_hold_ball` and
 * `cat_cafe_hold_ball` forms.
 *
 * Caller contract (all providers, per Sol R4):
 *   All providers now emit tool_result events — Claude CLI's user-turn
 *   tool_result content blocks are bridged in claude-ndjson-parser.ts (R4).
 *   Route-serial passes only confirmed-successful tool names via
 *   `classifyDurableTriggerResult` into `confirmedCallbackToolNames`.
 *   Failed tool calls (400/429/error) are excluded — the hint fires,
 *   which is the correct fail-closed behavior.
 */
const DURABLE_TRIGGER_SUFFIXES: readonly string[] = [
  'cat_cafe_hold_ball',
  'cat_cafe_register_scheduled_task',
  'cat_cafe_register_pr_tracking',
  'cat_cafe_register_issue_tracking',
  'cat_cafe_community_await_external',
] as const;

function hasDurableTriggerToolCall(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => DURABLE_TRIGGER_SUFFIXES.some((suffix) => name.endsWith(suffix)));
}

function hasRoutingExit(input: {
  lineStartMentions: readonly string[];
  structuredTargetCats: readonly string[];
  hasCoCreatorLineStartMention: boolean;
  hasTerminalDisposition?: boolean;
}): boolean {
  if (input.lineStartMentions.length > 0) return true;
  if (input.structuredTargetCats.length > 0) return true;
  if (input.hasCoCreatorLineStartMention) return true;
  if (input.hasTerminalDisposition) return true;
  return false;
}

export interface AckLivenessInput {
  /** True if this cat was invoked via A2A (@mention from another cat). */
  readonly isA2AInvocation: boolean;
  /**
   * Confirmed-successful durable trigger tool names only.
   * All providers emit tool_result events (Claude CLI bridge added R4);
   * route-serial classifies each via `classifyDurableTriggerResult` and
   * only includes confirmed successes in `confirmedCallbackToolNames`.
   */
  readonly toolNames: readonly string[];
  /** Line-start @mentions detected in the response text. */
  readonly lineStartMentions: readonly string[];
  /**
   * Confirmed structured target cats from successful tool_results
   * (post_message / cross_post_message). Unconfirmed tool_use inputs must NOT
   * be used — a failed post_message should not suppress the hint (P2-2 fix).
   */
  readonly structuredTargetCats: readonly string[];
  /** Whether the response text contains a co-creator line-start mention. */
  readonly hasCoCreatorLineStartMention: boolean;
  /** Whether the turn successfully settled its current structured lifecycle obligation. */
  readonly hasTerminalDisposition?: boolean;
}

export interface AckLivenessEvaluation {
  /** True iff the void-ack hint should fire. */
  readonly shouldEmit: boolean;
  /** True if the invocation had any routing exit (@ / structured routing). */
  readonly hasRoutingExit: boolean;
  /** True if the invocation called any durable trigger tool. */
  readonly hasDurableTrigger: boolean;
}

/**
 * Evaluate whether an A2A invocation ended without any durable trigger
 * or routing exit — the ball effectively dies.
 *
 * Only fires when ALL of:
 * 1. The cat was invoked via A2A (inline @mention or queue-dispatched)
 * 2. No routing exit exists (no @mention, no structured routing, no @co-creator)
 * 3. No durable trigger was bound (no hold_ball, register_scheduled_task, etc.)
 *
 * Non-A2A invocations (user-initiated) always return shouldEmit=false
 * because the user is watching and can re-invoke manually.
 */
export function evaluateAckLiveness(input: AckLivenessInput): AckLivenessEvaluation {
  if (!input.isA2AInvocation) {
    return { shouldEmit: false, hasRoutingExit: false, hasDurableTrigger: false };
  }

  const routing = hasRoutingExit(input);
  const trigger = hasDurableTriggerToolCall(input.toolNames);

  return {
    shouldEmit: !routing && !trigger,
    hasRoutingExit: routing,
    hasDurableTrigger: trigger,
  };
}

/**
 * Classify whether a tool_result for a durable trigger represents confirmed
 * success. Two-level check per Sol R3 P1:
 *
 * 1. Structural `toolResultStatus` (set by provider event transformers:
 *    Codex maps item.status; Gemini hardcodes 'ok'; CatAgent maps status).
 *    'ok' → confirmed success; 'error' → confirmed failure.
 *
 * 2. Tool-specific JSON body parsing (fallback when toolResultStatus is
 *    undefined or 'unknown'). Each durable trigger returns a different
 *    success shape:
 *      - hold_ball:               {status: 'ok', held: true, ...}
 *      - register_pr_tracking:    {status: 'ok', threadId, task}
 *      - register_issue_tracking: {status: 'ok', threadId, task}
 *      - register_scheduled_task: {success: true, task: {...}}
 *      - community_await_external:{state: 'awaiting_external', ...}
 *
 * Fail-closed: unknown shapes or parse errors → not confirmed (the hint
 * fires, which is safer than suppressing a genuine void ack).
 *
 * Pure function, zero IO.
 */
export function classifyDurableTriggerResult(
  toolName: string,
  resultContent: string | undefined,
  toolResultStatus: 'ok' | 'error' | 'unknown' | undefined,
): boolean {
  // Only classify durable trigger tools
  if (!DURABLE_TRIGGER_SUFFIXES.some((suffix) => toolName.endsWith(suffix))) return false;

  // Level 1: structural status from provider transformer
  if (toolResultStatus === 'ok') return true;
  if (toolResultStatus === 'error') return false;

  // Level 2: tool-specific body parsing
  if (!resultContent) return false;
  try {
    const jsonStart = resultContent.indexOf('{');
    if (jsonStart < 0) return false;
    const parsed = JSON.parse(resultContent.slice(jsonStart)) as Record<string, unknown>;
    // hold_ball / register_pr_tracking / register_issue_tracking
    if (parsed.status === 'ok' || parsed.status === 'duplicate') return true;
    // register_scheduled_task
    if (parsed.success === true) return true;
    // community_await_external
    if (parsed.state === 'awaiting_external') return true;
    // Explicit error markers
    if (parsed.isError === true || parsed.error) return false;
    // Unknown shape → fail-closed
    return false;
  } catch {
    return false;
  }
}

const TERMINAL_DISPOSITION_SUFFIXES: readonly string[] = ['complete_a2a_dispatch', 'complete_managed_hold'] as const;

/**
 * Current F167 dispatch/managed-hold protocols can end a turn by durably
 * dispositioning the exact wake instead of creating a future trigger. Treat
 * only a confirmed-successful terminal result as a liveness exit; tool intent
 * alone must not suppress the legacy LI-005 guard.
 */
export function classifyTerminalDispositionResult(
  toolName: string,
  resultContent: string | undefined,
  toolResultStatus: 'ok' | 'error' | 'unknown' | undefined,
): boolean {
  if (!TERMINAL_DISPOSITION_SUFFIXES.some((suffix) => toolName.endsWith(suffix))) return false;
  if (toolResultStatus === 'ok') return true;
  if (toolResultStatus === 'error') return false;
  if (!resultContent) return false;

  try {
    const jsonStart = resultContent.indexOf('{');
    if (jsonStart < 0) return false;
    const parsed = JSON.parse(resultContent.slice(jsonStart)) as Record<string, unknown>;
    if (parsed.status === 'ok' || parsed.status === 'duplicate' || parsed.success === true) return true;
    return false;
  } catch {
    return false;
  }
}
