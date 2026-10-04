/**
 * F210: AGY stream-json carrier — 事件解析与回合归纳。
 *
 * AGY CLI 1.2.7 起提供官方双向 NDJSON 载体：
 *   agy --input-format stream-json --output-format stream-json --print=
 * 输入信封用 `event` 字段（**不是** Claude SDK 的 `type`），输出是
 * `init` / `step_update` / `result` 三类事件 + 闭词表 `step_type`。
 *
 * 本模块只做纯函数解析，不负责 spawn、不负责渲染——这样上游一旦改词表，
 * 失败面收敛在这里，且能被 fixture 钉住（fixtures 取自真跑输出，非手写）。
 *
 * 设计红线（LL：未知不得折叠进确定性）：
 * 上游 `result.status` **不是** 成败真相。权限被拒时 agy 返回
 * `status:"SUCCESS"` + 空 `response`，唯一证据是 `denied_actions`。
 * 因此 `outcome` 是独立判定，`upstreamStatus` 原样保留供取证。
 */

/**
 * `UNKNOWN` 是上游给了我们不认识的 state 时的显式落点——**不是**默认值。
 * 旧实现把任何未知 state 静默折叠成 `ACTIVE`，于是「被取消的工具调用 +
 * status:"SUCCESS"」会被读成一个干净的成功回合（local review P1，2026-09-20）。
 */
export type AgyStepState = 'ACTIVE' | 'DONE' | 'ERROR' | 'UNKNOWN';

/** 协议漂移证据。非空 ⇒ 本回合不得给出确定结论。 */
export interface AgyProtocolAnomaly {
  readonly kind: 'unknown_step_state' | 'missing_result_response' | 'unknown_event';
  readonly detail: string;
}

export interface AgyStreamJsonUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
}

export interface AgyDeniedAction {
  readonly action: string;
  readonly displayName: string;
}

export interface AgyToolCall {
  readonly stepIndex: number;
  readonly state: AgyStepState;
  /** 上游原始 state 字符串，原样保留供取证（`UNKNOWN` 时尤其重要）。 */
  readonly rawState: string;
  readonly toolName: string;
  readonly parameters: Record<string, unknown>;
  readonly output: string;
  readonly errorMessage: string | null;
  readonly durationSeconds: number | null;
}

export type AgyStreamJsonEvent =
  | { readonly kind: 'init'; readonly cwd: string; readonly tools: readonly string[]; readonly permissionMode: string }
  | {
      readonly kind: 'step';
      readonly conversationId: string;
      readonly stepIndex: number;
      readonly state: AgyStepState;
      readonly rawState: string;
      readonly stepType: string;
      readonly textDelta: string | null;
      readonly toolName: string | null;
      readonly toolParameters: Record<string, unknown> | null;
      readonly toolOutput: string | null;
      readonly toolErrorMessage: string | null;
      readonly durationSeconds: number | null;
      readonly usage: AgyStreamJsonUsage | null;
    }
  | {
      readonly kind: 'result';
      readonly conversationId: string;
      readonly status: string;
      readonly response: string;
      /** `response` 字段是否真的存在。缺失 ≠ 空串——前者是协议漂移，后者是真的没话说。 */
      readonly hasResponse: boolean;
      readonly error: string | null;
      readonly numTurns: number;
      readonly usage: AgyStreamJsonUsage | null;
      readonly deniedActions: readonly AgyDeniedAction[];
    }
  /** 上游新增了我们还不认识的事件——显式保留，不静默丢弃。 */
  | { readonly kind: 'unknown'; readonly event: string; readonly raw: string };

/**
 * 回合判定。`denied` / `protocol_error` / `incomplete` 都是独立状态，
 * 不得并入 `ok` 或 `error`。`protocol_error` 表示上游给了我们读不懂的东西——
 * 此时本回合**没有**确定结论可言，调用方必须当作不可信。
 */
export type AgyTurnOutcome = 'ok' | 'denied' | 'protocol_error' | 'error' | 'empty' | 'incomplete';

export interface AgyStreamJsonTurn {
  readonly conversationId: string | null;
  readonly firstStepIndex: number | null;
  readonly lastStepIndex: number | null;
  readonly finalText: string;
  readonly toolCalls: readonly AgyToolCall[];
  readonly deniedActions: readonly AgyDeniedAction[];
  readonly usage: AgyStreamJsonUsage;
  /** 上游自报状态，原样保留供取证——**不要**用它判成败。 */
  readonly upstreamStatus: string | null;
  readonly outcome: AgyTurnOutcome;
  readonly diagnosis: string;
  readonly unknownEvents: readonly string[];
  /** 协议漂移证据。非空 ⇒ `outcome` 必为 `protocol_error`（除非有更强的 `denied` 证据）。 */
  readonly anomalies: readonly AgyProtocolAnomaly[];
}

const EMPTY_USAGE: AgyStreamJsonUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseUsage(value: unknown): AgyStreamJsonUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    inputTokens: asNumber(record.input_tokens) ?? 0,
    outputTokens: asNumber(record.output_tokens) ?? 0,
    thinkingTokens: asNumber(record.thinking_tokens) ?? 0,
    cacheReadTokens: asNumber(record.cache_read_tokens) ?? 0,
    totalTokens: asNumber(record.total_tokens) ?? 0,
  };
}

/**
 * 不认识的 state 落到 `UNKNOWN`，**不**猜成 `ACTIVE`。
 * 原始字符串由调用方一并保留（`rawState`），供上层取证和上报漂移。
 */
function parseState(value: unknown): AgyStepState {
  return value === 'ACTIVE' || value === 'DONE' || value === 'ERROR' ? value : 'UNKNOWN';
}

function parseDeniedActions(value: unknown): readonly AgyDeniedAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const action = record ? asString(record.action) : null;
    if (!action) return [];
    return [{ action, displayName: (record && asString(record.display_name)) ?? action }];
  });
}

/** 构造一条输入 NDJSON。信封是 `event`，写成 `type` 会被 agy 拒收。 */
export function encodeAgyStreamJsonUserMessage(text: string): string {
  return JSON.stringify({
    event: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function parseInitEvent(payload: unknown): AgyStreamJsonEvent {
  const init = asRecord(payload) ?? {};
  return {
    kind: 'init',
    cwd: asString(init.cwd) ?? '',
    tools: Array.isArray(init.tools) ? init.tools.filter((tool): tool is string => typeof tool === 'string') : [],
    permissionMode: asString(init.permission_mode) ?? '',
  };
}

function parseStepEvent(step: Record<string, unknown>): AgyStreamJsonEvent {
  const toolInfo = asRecord(step.tool_info);
  const toolError = toolInfo ? asRecord(toolInfo.error) : null;
  return {
    kind: 'step',
    conversationId: asString(step.conversation_id) ?? '',
    stepIndex: asNumber(step.step_index) ?? -1,
    state: parseState(step.state),
    rawState: asString(step.state) ?? '',
    stepType: asString(step.step_type) ?? 'unknown',
    textDelta: asString(step.text_delta),
    toolName: asString(step.tool_name),
    toolParameters: toolInfo ? asRecord(toolInfo.parameters) : null,
    toolOutput: toolInfo ? asString(toolInfo.output) : null,
    toolErrorMessage: toolError ? asString(toolError.message) : null,
    durationSeconds: asNumber(step.duration_seconds),
    usage: parseUsage(step.usage),
  };
}

function parseResultEvent(result: Record<string, unknown>): AgyStreamJsonEvent {
  return {
    kind: 'result',
    conversationId: asString(result.conversation_id) ?? '',
    status: asString(result.status) ?? 'UNKNOWN',
    response: asString(result.response) ?? '',
    hasResponse: typeof result.response === 'string',
    error: asString(result.error),
    numTurns: asNumber(result.num_turns) ?? 0,
    usage: parseUsage(result.usage),
    deniedActions: parseDeniedActions(result.denied_actions),
  };
}

/** 解析单行。语法坏掉返回 null（fail-open），语义未知返回 `unknown`（显式保留）。 */
export function parseAgyStreamJsonLine(line: string): AgyStreamJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  const event = record ? asString(record.event) : null;
  if (!record || !event) return null;

  const unknown: AgyStreamJsonEvent = { kind: 'unknown', event, raw: trimmed };
  if (event === 'init') return parseInitEvent(record.init);
  if (event === 'step_update') {
    const step = asRecord(record.step_update);
    return step ? parseStepEvent(step) : unknown;
  }
  if (event === 'result') {
    const result = asRecord(record.result);
    return result ? parseResultEvent(result) : unknown;
  }
  return unknown;
}

function describeOutcome(
  outcome: AgyTurnOutcome,
  deniedActions: readonly AgyDeniedAction[],
  toolCalls: readonly AgyToolCall[],
  resultError: string | null,
  anomalies: readonly AgyProtocolAnomaly[] = [],
): string {
  switch (outcome) {
    case 'protocol_error':
      return `AGY protocol drift — result is not trustworthy: ${anomalies.map((anomaly) => anomaly.detail).join('; ')}`;
    case 'denied': {
      const names = deniedActions.map((action) => action.displayName).join(', ');
      const reasons = toolCalls
        .map((call) => call.errorMessage)
        .filter((message): message is string => Boolean(message));
      const detail = reasons.length > 0 ? ` — ${reasons[0]}` : '';
      return `AGY denied ${deniedActions.length} action(s) [${names}] with no human to approve them${detail}`;
    }
    case 'error':
      return resultError ? `AGY turn failed: ${resultError}` : 'AGY turn reported a non-success status';
    case 'empty':
      return 'AGY turn completed with no text output and no denial evidence';
    case 'incomplete':
      return 'AGY stream ended without a terminal result event';
    default:
      return 'AGY turn completed';
  }
}

/**
 * 归纳一个回合。`finalText` 首选上游 `result.response`；没有 result 时
 * 退回拼接 `text_delta`，并把 outcome 标成 `incomplete` 而不是假装成功。
 */
interface TurnAccumulator {
  readonly toolCalls: Map<number, AgyToolCall>;
  readonly unknownEvents: string[];
  readonly anomalies: AgyProtocolAnomaly[];
  readonly deltas: string[];
  conversationId: string | null;
  firstStepIndex: number | null;
  lastStepIndex: number | null;
  result: Extract<AgyStreamJsonEvent, { kind: 'result' }> | null;
}

function absorbStep(state: TurnAccumulator, event: Extract<AgyStreamJsonEvent, { kind: 'step' }>): void {
  state.conversationId ??= event.conversationId || null;
  if (event.stepIndex >= 0) {
    if (state.firstStepIndex === null) state.firstStepIndex = event.stepIndex;
    state.lastStepIndex = event.stepIndex;
  }
  if (event.state === 'UNKNOWN') {
    state.anomalies.push({
      kind: 'unknown_step_state',
      detail: `step ${event.stepIndex} reported unrecognized state ${JSON.stringify(event.rawState)}`,
    });
  }
  if (event.textDelta) state.deltas.push(event.textDelta);
  if (event.stepType !== 'tool' || !event.toolName) return;

  // 同一 step_index 先 ACTIVE 后 DONE/ERROR，且后到的事件是**稀疏**的：
  // DONE 常只带 output，不重复 parameters。整条覆盖会把 ACTIVE 阶段的参数证据抹掉
  // （local review P2）。因此逐字段合并——新值只在真的携带内容时才生效，
  // 唯独 state/rawState 以最新事件为准（它描述的是当下，不是累积）。
  const previous = state.toolCalls.get(event.stepIndex);
  state.toolCalls.set(event.stepIndex, {
    stepIndex: event.stepIndex,
    state: event.state,
    rawState: event.rawState,
    toolName: event.toolName,
    parameters: event.toolParameters ?? previous?.parameters ?? {},
    output: event.toolOutput ?? previous?.output ?? '',
    errorMessage: event.toolErrorMessage ?? previous?.errorMessage ?? null,
    durationSeconds: event.durationSeconds ?? previous?.durationSeconds ?? null,
  });
}

function decideOutcome(
  result: Extract<AgyStreamJsonEvent, { kind: 'result' }> | null,
  deniedActions: readonly AgyDeniedAction[],
  anomalies: readonly AgyProtocolAnomaly[],
  finalText: string,
): AgyTurnOutcome {
  // `denied` 先于 `protocol_error`：拒绝是上游给出的**肯定**证据，可操作性最强。
  if (deniedActions.length > 0) return 'denied';
  // 读不懂的字段一旦出现，后面几条判定的前提就不成立了——不许再下确定结论。
  if (anomalies.length > 0) return 'protocol_error';
  if (!result) return 'incomplete';
  if (result.status !== 'SUCCESS' || result.error) return 'error';
  return finalText.trim() === '' ? 'empty' : 'ok';
}

function accumulateTurn(lines: Iterable<string>): TurnAccumulator {
  const state: TurnAccumulator = {
    toolCalls: new Map<number, AgyToolCall>(),
    unknownEvents: [],
    anomalies: [],
    deltas: [],
    conversationId: null,
    firstStepIndex: null,
    lastStepIndex: null,
    result: null,
  };

  for (const line of lines) {
    const event = parseAgyStreamJsonLine(line);
    if (!event) continue;
    if (event.kind === 'unknown') state.unknownEvents.push(event.event);
    else if (event.kind === 'result') {
      state.result = event;
      state.conversationId ??= event.conversationId || null;
    } else if (event.kind === 'step') absorbStep(state, event);
  }

  return state;
}

export function summarizeAgyStreamJsonTurn(lines: Iterable<string>): AgyStreamJsonTurn {
  const state = accumulateTurn(lines);
  const { result, conversationId, firstStepIndex, lastStepIndex, unknownEvents } = state;
  if (result && !result.hasResponse) {
    state.anomalies.push({
      kind: 'missing_result_response',
      detail: `terminal result for status ${JSON.stringify(result.status)} carried no "response" field`,
    });
  }

  const deniedActions = result?.deniedActions ?? [];
  // 只有上游真的给了 `response` 才当权威文本；字段缺失时退回本轮 delta 拼接，
  // 而不是把"没拿到"渲染成"回答为空"。
  const finalText = result?.hasResponse ? result.response : state.deltas.join('');
  const upstreamStatus = result?.status ?? null;
  const anomalies = state.anomalies;
  const outcome = decideOutcome(result, deniedActions, anomalies, finalText);
  const orderedToolCalls = [...state.toolCalls.values()].sort((a, b) => a.stepIndex - b.stepIndex);

  return {
    conversationId,
    firstStepIndex,
    lastStepIndex,
    finalText,
    toolCalls: orderedToolCalls,
    deniedActions,
    usage: result?.usage ?? EMPTY_USAGE,
    upstreamStatus,
    outcome,
    diagnosis: describeOutcome(outcome, deniedActions, orderedToolCalls, result?.error ?? null, anomalies),
    unknownEvents,
    anomalies,
  };
}
