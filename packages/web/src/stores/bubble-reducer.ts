import type {
  BubbleEventType,
  BubbleInvariantViolation,
  BubbleKind,
  BubbleOriginPhase,
  BubbleRecoveryAction,
  BubbleSourcePath,
} from '@cat-cafe/shared';
import {
  deriveBubbleKindFromMessage,
  findBubbleStoreInvariantViolations,
  validateIncomingBubbleEvent,
} from './bubble-invariants';
import type { ChatMessage } from './chat-types';

export interface BubbleEvent {
  type: BubbleEventType;
  threadId: string;
  actorId: string;
  canonicalInvocationId?: string;
  bubbleKind: BubbleKind;
  originPhase: BubbleOriginPhase;
  sourcePath: BubbleSourcePath;
  messageId?: string;
  seq?: number;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

export interface BubbleReducerInput {
  threadId: string;
  event: BubbleEvent;
  currentMessages: ChatMessage[];
}

export interface BubbleReducerOutput {
  nextMessages: ChatMessage[];
  violations: BubbleInvariantViolation[];
  recoveryAction: BubbleRecoveryAction;
}

// Round 9+10 P2 (砚砚 review): reducer 必须 deterministic + 不复用已存在 suffix。
// Round 8 module-local counter 破坏 determinism；round 9 用 count
// 在 suffix gap 时复用已有 id（如 [..-1] count=1 撞 -1）。改为 parse 所有
// 现存 local-id 的 suffix，取 max+1：deterministic + 永不复用。
function deriveLocalFallbackSeq(currentMessages: ChatMessage[], event: BubbleEvent): number {
  const localPrefix = `local-${event.threadId}-${event.actorId}-`;
  let maxSeq = -1;
  for (const m of currentMessages) {
    if (!m.id.startsWith(localPrefix)) continue;
    // id format: local-{thread}-{actor}-{ts}-{seq}; trailing segment is seq
    const lastDash = m.id.lastIndexOf('-');
    if (lastDash <= 0) continue;
    const seqPart = m.id.slice(lastDash + 1);
    const n = Number.parseInt(seqPart, 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  return maxSeq + 1;
}

function ensureMessageId(event: BubbleEvent, currentMessages: ChatMessage[] = []): string {
  if (event.messageId) return event.messageId;
  if (!event.canonicalInvocationId) {
    // Round 11 P1 (砚砚): no Date.now() — reducer must be deterministic.
    // If caller omits timestamp, fallback to 0 so same input → same id.
    const ts = event.timestamp ?? 0;
    const seq = event.seq ?? deriveLocalFallbackSeq(currentMessages, event);
    return `local-${event.threadId}-${event.actorId}-${ts}-${seq}`;
  }
  // Round 7 P1: include bubbleKind so coexisting kinds (thinking + assistant_text)
  // under same invocation get distinct fallback ids when messageId is omitted.
  return `msg-${event.canonicalInvocationId}-${event.actorId}-${event.bubbleKind}`;
}

function originFromPhase(phase: BubbleOriginPhase): ChatMessage['origin'] {
  if (phase === 'stream') return 'stream';
  if (phase === 'callback/history') return 'callback';
  return undefined;
}

function makePlaceholder(event: BubbleEvent, content = '', currentMessages: ChatMessage[] = []): ChatMessage {
  return {
    id: ensureMessageId(event, currentMessages),
    type: 'assistant',
    catId: event.actorId,
    content,
    // Round 11 P1: timestamp 也走 deterministic fallback（caller 应传 ts）
    timestamp: event.timestamp ?? 0,
    isStreaming: event.originPhase === 'stream',
    origin: originFromPhase(event.originPhase),
    extra: event.canonicalInvocationId ? { stream: { invocationId: event.canonicalInvocationId } } : undefined,
  };
}

// Round 5 P1: incoming validation proxy must preserve event.bubbleKind shape so
// deriveBubbleKindFromMessage returns the correct kind (not always assistant_text).
// Used only by applyBubbleEvent's incoming validation; reduce functions still use
// makePlaceholder for actual store mutations (which derive kind organically).
function makeIncomingProxy(event: BubbleEvent, currentMessages: ChatMessage[] = []): ChatMessage {
  const base = makePlaceholder(event, '', currentMessages);
  switch (event.bubbleKind) {
    case 'system_status':
      return { ...base, type: 'system' };
    case 'thinking':
      return { ...base, thinking: '​' };
    case 'tool_or_cli':
      // F183 Phase B1.6 (砚砚 R2 P1) — proxy 必须 derive 回 tool_or_cli 跟 event.
      // bubbleKind 一致。我们把 stream-bound streaming UI-compat container 视作
      // assistant_text，所以 proxy 必须不带 streaming 标记，否则会被推成
      // assistant_text 让 round 5 P1 canonical-split 测试 bubbleKind 报错。
      return {
        ...base,
        isStreaming: false,
        origin: undefined,
        toolEvents: [{ id: 'proxy', kind: 'tool_use', name: 'proxy' } as never],
      };
    case 'rich_block':
      return {
        ...base,
        extra: {
          ...base.extra,
          rich: { v: 1, blocks: [{ id: 'proxy', kind: 'card', v: 1 } as never] },
        },
      };
    default:
      return base;
  }
}

function findExistingByStableKey(
  messages: ChatMessage[],
  event: BubbleEvent,
): { index: number; message: ChatMessage } | undefined {
  // ADR-033 不变量 #4: placeholder 临时态（无 canonicalInvocationId）是 local-only
  // provisional bubble，不能参与 stable key 查重；否则两个 invocationless event
  // 会被 `undefined !== undefined === false` 误判为同一气泡（砚砚 re-review P1）。
  if (!event.canonicalInvocationId) return undefined;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.catId !== event.actorId) continue;
    const existingInvocationId = m.extra?.stream?.invocationId;
    if (!existingInvocationId) continue; // existing local-only 不参与 stable key 查重
    if (existingInvocationId !== event.canonicalInvocationId) continue;
    if (deriveBubbleKindFromMessage(m) !== event.bubbleKind) continue;
    return { index: i, message: m };
  }
  return undefined;
}

// ADR-033 placeholder 单调升级链 draft/local → stream → callback/history。
// 当 canonical event 到达时，找匹配 (actor, kind) 的 local-only streaming
// placeholder 升级它，避免新建 canonical bubble + 留 provisional 孤儿
// （砚砚 re-review round 3 P1）。
//
// Round 4 P1: 多个 candidate 时**不猜测**——按 ADR-033 不变量 #6
// "禁止 warn 后启发式 merge"，ambiguous 由顶层 applyBubbleEvent quarantine。
// 这里只在 unique candidate 时返回；≥2 时返回 undefined（让上层逻辑挑路径）。
function findUpgradableLocalPlaceholders(
  messages: ChatMessage[],
  event: BubbleEvent,
): Array<{ index: number; message: ChatMessage }> {
  if (!event.canonicalInvocationId) return [];
  const candidates: Array<{ index: number; message: ChatMessage }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.catId !== event.actorId) continue;
    if (m.extra?.stream?.invocationId) continue; // already has canonical id → not local
    if (deriveBubbleKindFromMessage(m) !== event.bubbleKind) continue;
    // Round 6 P1 (云端): require explicit streaming markers — hydrated callback
    // messages typically have isStreaming undefined and may lack invocationId,
    // they must NOT be hijacked by canonical event upgrade.
    if (m.isStreaming !== true) continue;
    if (m.origin !== 'stream') continue;
    candidates.push({ index: i, message: m });
  }
  return candidates;
}

function findUpgradableLocalPlaceholder(
  messages: ChatMessage[],
  event: BubbleEvent,
): { index: number; message: ChatMessage } | undefined {
  const all = findUpgradableLocalPlaceholders(messages, event);
  return all.length === 1 ? all[0] : undefined; // ambiguous (≥2) → no heuristic merge
}

function withCanonicalUpgrade(
  message: ChatMessage,
  event: BubbleEvent,
  patch: Partial<ChatMessage>,
  currentMessages: ChatMessage[] = [],
): ChatMessage {
  return {
    ...message,
    ...patch,
    id: ensureMessageId(event, currentMessages),
    extra: {
      ...message.extra,
      stream: { invocationId: event.canonicalInvocationId },
    },
  };
}

function reduceStreamStarted(messages: ChatMessage[], event: BubbleEvent): ChatMessage[] {
  if (findExistingByStableKey(messages, event)) return messages;
  const upgrade = findUpgradableLocalPlaceholder(messages, event);
  if (upgrade) {
    const next = [...messages];
    next[upgrade.index] = withCanonicalUpgrade(upgrade.message, event, {}, messages);
    return next;
  }
  return [...messages, makePlaceholder(event, '', messages)];
}

function reduceStreamChunk(messages: ChatMessage[], event: BubbleEvent): ChatMessage[] {
  const chunkContent = (event.payload?.content as string) ?? '';
  // Round 5 P1 (云端 codex F183-B1.2.1): textMode='replace' 重写 bubble content（不
  // 累加），对齐 useAgentMessages.ts:991 patchThreadMessage('replace') 既有语义。
  // 默认 'append'（连续 stream chunks 累加）。
  const isReplace = event.payload?.textMode === 'replace';
  const existing = findExistingByStableKey(messages, event);
  if (existing) {
    const next = [...messages];
    const nextContent = isReplace ? chunkContent : existing.message.content + chunkContent;
    next[existing.index] = { ...existing.message, content: nextContent };
    return next;
  }
  const upgrade = findUpgradableLocalPlaceholder(messages, event);
  if (upgrade) {
    const next = [...messages];
    const nextContent = isReplace ? chunkContent : upgrade.message.content + chunkContent;
    next[upgrade.index] = withCanonicalUpgrade(
      upgrade.message,
      event,
      {
        content: nextContent,
      },
      messages,
    );
    return next;
  }
  return [...messages, makePlaceholder(event, chunkContent, messages)];
}

// F183 Phase B1.3 — terminal lifecycle marker. `done` event 没有自己的 bubble，它
// 标记 invocation 完成 → 把该 invocation 下所有 streaming bubbles（assistant_text、
// tool_or_cli、thinking 等共存 kind 全部）isStreaming=false。invocationless `done`
// 在 reducer 是 no-op（lifecycle 在 caller 用 cat status / slot cleanup 等 side-effect
// 处理；ADR-033 不变量 #4 禁止 invocationless 参与 stable key 查重）。
// F183 Phase B1.6 — tool_event / cli_output reducer: append toolEvent 到对应
// invocation 的 assistant_text bubble 的 toolEvents 字段（UI-compat 数据模型）。
// ADR-033 设计 tool_or_cli 为独立 kind bubble，但当前 UI 把 tool events 当
// assistant_text 子字段渲染，reducer 维持 UI 约定。caller 通过 payload.toolEvent
// 传入 ToolEvent 结构（id/type/label/detail/timestamp）。invocationless 是
// reducer no-op（caller 走 legacy ensureActiveAssistantMessage + appendToolEvent）。
function reduceToolEvent(messages: ChatMessage[], event: BubbleEvent): ChatMessage[] {
  if (!event.canonicalInvocationId) return messages;
  const toolEvent = event.payload?.toolEvent as ChatMessage['toolEvents'] extends (infer T)[] | undefined ? T : never;
  if (!toolEvent) return messages;

  // 找匹配 invocation+cat 的 assistant_text bubble。优先 isStreaming（active），
  // 找不到再找已 finalize 的同 invocation bubble（late tool event after done）。
  // F183 Phase B1.6 (cloud P1): 必须 kind filter 'assistant_text'。ADR-033
  // 允许 thinking + assistant_text 同 invocation 共存；如果不区分 kind 直接拿
  // 第一个 streaming assistant bubble，tool event 可能落到 thinking bubble，
  // UI-compat 模型 (toolEvents on assistant_text) 失败。R2 修法已让 streaming
  // UI-compat container（empty + toolEvents + 三件套）derive 回 assistant_text，
  // 所以 'assistant_text' filter 同时覆盖 fresh seed (no toolEvents) 和后续追加
  // toolEvents 的 transient 状态。
  const isAssistantTextTarget = (m: ChatMessage): boolean =>
    m.type === 'assistant' &&
    m.catId === event.actorId &&
    m.extra?.stream?.invocationId === event.canonicalInvocationId &&
    deriveBubbleKindFromMessage(m) === 'assistant_text';
  let targetIdx = messages.findIndex((m) => isAssistantTextTarget(m) && m.isStreaming === true);
  if (targetIdx === -1) {
    targetIdx = messages.findIndex(isAssistantTextTarget);
  }

  if (targetIdx !== -1) {
    const next = [...messages];
    const target = next[targetIdx];
    next[targetIdx] = {
      ...target,
      toolEvents: [...(target.toolEvents ?? []), toolEvent],
    };
    return next;
  }

  // F183 Phase B1.6 (砚砚 R1 P1) — 没现成 bubble 时 reducer 不创建 placeholder。
  // 原因：empty content + toolEvents 的气泡 deriveBubbleKindFromMessage 推成
  // 'tool_or_cli'，跟后续 stream_chunk(assistant_text) 同 id 触发 canonical-split。
  // 改成 no-op 返回 messages 原引用，caller (active path 的 ensureActive
  // AssistantMessage + appendToolEvent，bg path 的等价语义) 是 bubble 创建出口。
  // wire-up 通过 `nextMessages === currentMessages` 引用相等判断 reducer 是否
  // handled，未 handled 就走 legacy appendToolEvent 兜底。
  return messages;
}

function reduceDoneEvent(messages: ChatMessage[], event: BubbleEvent): ChatMessage[] {
  if (!event.canonicalInvocationId) return messages;
  let changed = false;
  const next: ChatMessage[] = [];
  for (const m of messages) {
    const matches =
      m.catId === event.actorId &&
      m.extra?.stream?.invocationId === event.canonicalInvocationId &&
      m.isStreaming === true;
    if (matches) {
      next.push({ ...m, isStreaming: false });
      changed = true;
    } else {
      next.push(m);
    }
  }
  return changed ? next : messages;
}

// F183 Phase B1.3 — error/timeout 事件 = 可见 system_status bubble，承载 error
// content。不自动 finalize streaming bubble（terminal orchestration 在 caller
// 处理 cat status / slot cleanup / toast；reducer 只负责落 visible message）。
//
// 砚砚 R1 P1 (B1.3 review): system_status 也必须遵守 ADR-033 不变量 #4 同
// (actor, invocationId, kind) 唯一性。canonical event 命中 stable key 时替换
// 同一 bubble，不追加；invocationless event 是 local-only（ADR #4），允许
// 多条 standalone bubble 各自带 deterministic local id。
function reduceErrorEvent(messages: ChatMessage[], event: BubbleEvent): ChatMessage[] {
  // F183 Phase B1.5 — payload.content 是 caller 预拼好的完整 display 字符串
  // （含 errorSubtype label 之类的 enrichment），优先用它。否则保留 B1.3 的
  // 'Error: {error|payload.content}' 兜底，向后兼容现有测试 + invocationless
  // direct error event 路径。
  const explicitContent = event.payload?.content as string | undefined;
  const errorText = (event.payload?.error as string | undefined) ?? explicitContent ?? 'Unknown error';
  const defaultContent = `Error: ${errorText}`;
  const content = explicitContent && explicitContent.startsWith('Error') ? explicitContent : defaultContent;

  // F183 Phase B1.5 — caller 通过 payload.extra 透传 bubble.extra 的扩展字段
  // （如 timeoutDiagnostics）。reducer 不解释字段含义，原样合并到 bubble.extra。
  const extraOverride = event.payload?.extra as ChatMessage['extra'] | undefined;
  const buildExtra = (existingExtra: ChatMessage['extra']): ChatMessage['extra'] | undefined => {
    const merged: ChatMessage['extra'] = { ...(existingExtra ?? {}), ...(extraOverride ?? {}) };
    if (event.canonicalInvocationId) {
      merged.stream = { invocationId: event.canonicalInvocationId };
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  };

  // canonical (有 invocationId) 路径: 命中 stable key → 替换；不命中 → 追加新
  // bubble，并带上 extra.stream.invocationId 让后续 same-key event 能 dedup。
  if (event.canonicalInvocationId) {
    const existing = findExistingByStableKey(messages, event);
    if (existing) {
      const next = [...messages];
      next[existing.index] = {
        ...existing.message,
        content,
        timestamp: event.timestamp ?? existing.message.timestamp,
        ...(buildExtra(existing.message.extra) ? { extra: buildExtra(existing.message.extra) } : {}),
      };
      return next;
    }
    const errorBubble: ChatMessage = {
      id: ensureMessageId(event, messages),
      type: 'system',
      variant: 'error',
      catId: event.actorId,
      content,
      timestamp: event.timestamp ?? 0,
      ...(buildExtra(undefined) ? { extra: buildExtra(undefined) } : {}),
    };
    return [...messages, errorBubble];
  }

  // invocationless 路径: ADR #4 禁止参与 stable key；id 走 local fallback，
  // 多条 invocationless error 允许各自落 standalone bubble。
  const errorBubble: ChatMessage = {
    id: ensureMessageId(event, messages),
    type: 'system',
    variant: 'error',
    catId: event.actorId,
    content,
    timestamp: event.timestamp ?? 0,
    ...(buildExtra(undefined) ? { extra: buildExtra(undefined) } : {}),
  };
  return [...messages, errorBubble];
}

function reduceCallbackFinal(messages: ChatMessage[], event: BubbleEvent): ChatMessage[] {
  const finalContent = (event.payload?.content as string) ?? '';

  // F183 Phase B1.4 — invocationless callback wire-up: caller resolved a target
  // bubble (e.g. replacementTarget = recently finalized stream / rich placeholder)
  // and passes its id via event.messageId as a patch hint. ADR-033 #4 禁止 invocationless
  // 参与 stable key 查重，所以走显式 id lookup —— 命中就地 patch；未命中走
  // makePlaceholder fallback（与 caller 没传 hint 时的"创建 standalone bubble"语义一致）。
  // 只在 invocationless 路径生效；canonical event 仍走下方 findExistingByStableKey。
  if (!event.canonicalInvocationId && event.messageId) {
    const idx = messages.findIndex((m) => m.id === event.messageId);
    if (idx !== -1) {
      const next = [...messages];
      next[idx] = {
        ...next[idx],
        content: finalContent,
        isStreaming: false,
        origin: 'callback',
      };
      return next;
    }
  }

  const existing = findExistingByStableKey(messages, event);
  if (existing) {
    const next = [...messages];
    next[existing.index] = {
      ...existing.message,
      // Round 12 P1 (砚砚): upgrade id to incoming backend messageId so
      // hydration / id-based reconciliation 用稳定 backend id，不停留 fallback。
      id: event.messageId ?? existing.message.id,
      content: finalContent,
      isStreaming: false,
      origin: 'callback',
    };
    return next;
  }
  // F183 Phase B1.2.4 (砚砚 verdict): callback-specific upgrade policy。
  // 不复用通用 findUpgradableLocalPlaceholder（stream 语义太宽，会 hijack live
  // invocationless stream）。callback 升级规则更窄：
  //   - exact stable key match（findExistingByStableKey）— 已在上方处理
  //   - rich/tool-only invocationless placeholder（empty content + has rich blocks/toolEvents）— 可以升级
  //   - contentful invocationless live stream — 绝不能 hijack
  //   - 无 safe target — makePlaceholder 创建 standalone callback bubble
  const upgrade = findUpgradableCallbackPlaceholder(messages, event);
  if (upgrade) {
    const next = [...messages];
    next[upgrade.index] = withCanonicalUpgrade(
      upgrade.message,
      event,
      {
        content: finalContent,
        isStreaming: false,
        origin: 'callback',
      },
      messages,
    );
    return next;
  }
  const ph = makePlaceholder(event, finalContent, messages);
  return [...messages, { ...ph, isStreaming: false, origin: 'callback' }];
}

// F183 Phase B1.2.4 — callback-specific placeholder upgrade policy（窄 guard）。
// 与 stream 通用 upgrade 区别：
//   - stream: 任何 unbound streaming bubble 都升级（active 路径主流程）
//   - callback: 仅 rich/tool-only invocationless placeholder（empty content + has rich/tool markers）
//     contentful invocationless live stream 不能被 hijack（stale callback 场景保护）
function findUpgradableCallbackPlaceholder(
  messages: ChatMessage[],
  event: BubbleEvent,
): { index: number; message: ChatMessage } | undefined {
  if (!event.canonicalInvocationId) return undefined;
  // callback 升级仅对 assistant_text incoming：rich/tool placeholder 容器升级到 text bubble
  if (event.bubbleKind !== 'assistant_text') return undefined;
  const candidates: Array<{ index: number; message: ChatMessage }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.catId !== event.actorId) continue;
    if (m.origin !== 'stream') continue;
    // 关键 guard: rich/tool-only placeholder。需要满足：empty content（trim 后无字符）
    // + 有 rich blocks 或 tool events。contentful invocationless live stream
    // （plain assistant_text）绝不能 hijack。
    // 砚砚/云端 round 3 P1: 不能要求 m.isStreaming === true。done/error 可能在 callback
    // 到达前 finalize rich/tool placeholder（empty content + rich/tool markers），那种
    // placeholder 仍是正确升级 target；强制 isStreaming=true 会让 callback 创建
    // standalone bubble + placeholder 成 orphan（split-bubble 回归）。
    const hasContentfulStream = (m.content ?? '').trim().length > 0;
    if (hasContentfulStream) continue;
    const hasRichBlocks = !!m.extra?.rich?.blocks?.length;
    const hasToolEvents = !!m.toolEvents?.length;
    if (!hasRichBlocks && !hasToolEvents) continue;
    // bound placeholder：仅当 invocationId 严格匹配才是同一逻辑 bubble（kind 升级合法）
    // unbound rich/tool placeholder：留 legacy guard（任意 invocation 的 callback 都可适配）
    const boundInv = m.extra?.stream?.invocationId;
    if (boundInv && boundInv !== event.canonicalInvocationId) continue;
    candidates.push({ index: i, message: m });
  }
  // ADR-033 invariant #6 禁止 heuristic merge：≥2 候选 → ambiguous，不升级
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * F183 Phase B1 BubbleReducer — single entry for all message state mutations.
 *
 * All write paths build a BubbleEvent and call applyBubbleEvent. Direct
 * chatStore.addMessageToThread will be forbidden in dev/test by Task 11 lint rule.
 *
 * B1 follow-up: late stream_chunk arriving after callback_final routes to
 * catch-up (drop event without violation), per ADR-033 Section 3.1 "recovery
 * action" contract — late chunks after a finalized bubble are expected during
 * normal stream/callback race, not a duplicate violation.
 */
export function applyBubbleEvent(input: BubbleReducerInput): BubbleReducerOutput {
  const { event, currentMessages, threadId } = input;

  // P1-2 (砚砚 review): incoming invariant validation BEFORE applying event.
  // Catches canonical-split (same messageId, different stable key) which
  // post-hoc store scan cannot detect.
  // Round 5 P1: use makeIncomingProxy (kind-aware) instead of makePlaceholder
  // (always assistant_text), so non-text incoming events are validated correctly.
  const incomingProxy = makeIncomingProxy(event, currentMessages);
  const incomingViolation = validateIncomingBubbleEvent(currentMessages, incomingProxy, {
    threadId,
    eventType: event.type,
    sourcePath: event.sourcePath,
    originPhase: event.originPhase,
    timestamp: event.timestamp,
    seq: event.seq ?? null,
  });

  if (incomingViolation?.violationKind === 'canonical-split') {
    return {
      nextMessages: currentMessages,
      violations: [incomingViolation],
      recoveryAction: 'sot-override',
    };
  }

  // Phase-regression handling (round 7 P2 corrected):
  // - stream_chunk: B1 follow-up known race exception → catch-up (silently drop)
  // - 其他 event type (stream_started / thinking_chunk / etc.): quarantine
  //   with violation —— 砚砚 round 7 P2 明确："非 stream_chunk 的 phase-regression
  //   不能返回 'none'，应 quarantine"。catch-up 静默 hide 违例，quarantine 保留诊断信息。
  if (incomingViolation?.violationKind === 'phase-regression') {
    if (event.type === 'stream_chunk') {
      return {
        nextMessages: currentMessages,
        violations: [],
        recoveryAction: 'catch-up',
      };
    }
    return {
      nextMessages: currentMessages,
      violations: [incomingViolation],
      recoveryAction: 'quarantine',
    };
  }

  // Round 4 P1: ambiguous upgrade — multiple local placeholders match canonical event.
  // ADR-033 invariant #6 禁止 heuristic merge；不挑、不升级、不新建，event quarantine。
  // 只在 incoming 有 canonical id 且没有 strict-key match 时检测。
  // F183 Phase B1.2.4 (砚砚 round 1 P1-1): callback_final 不能用 stream 通用 upgrade
  // 候选做 ambiguous guard。两个 contentful invocationless live streams + explicit
  // callback_final 应该保留 streams 并创建 standalone callback，而非 quarantine 丢失
  // callback authoritative content。callback 的 ambiguous 由 reduceCallbackFinal
  // 内部 findUpgradableCallbackPlaceholder（窄 policy）自己处理。
  if (
    event.type !== 'callback_final' &&
    event.canonicalInvocationId &&
    !findExistingByStableKey(currentMessages, event)
  ) {
    const upgradeCandidates = findUpgradableLocalPlaceholders(currentMessages, event);
    if (upgradeCandidates.length >= 2) {
      return {
        nextMessages: currentMessages,
        violations: [],
        recoveryAction: 'quarantine',
      };
    }
  }

  let nextMessages = currentMessages;
  switch (event.type) {
    case 'stream_started':
      nextMessages = reduceStreamStarted(currentMessages, event);
      break;
    case 'stream_chunk':
      nextMessages = reduceStreamChunk(currentMessages, event);
      break;
    case 'callback_final':
      nextMessages = reduceCallbackFinal(currentMessages, event);
      break;
    case 'done':
      nextMessages = reduceDoneEvent(currentMessages, event);
      break;
    case 'error':
    case 'timeout':
      nextMessages = reduceErrorEvent(currentMessages, event);
      break;
    case 'tool_event':
    case 'cli_output':
      nextMessages = reduceToolEvent(currentMessages, event);
      break;
    default:
      break;
  }

  const violations = findBubbleStoreInvariantViolations(nextMessages, {
    threadId,
    eventType: event.type,
    sourcePath: event.sourcePath,
    originPhase: event.originPhase,
    timestamp: event.timestamp,
    seq: event.seq ?? null,
  });

  return {
    nextMessages,
    violations,
    recoveryAction: violations.length > 0 ? 'quarantine' : 'none',
  };
}
