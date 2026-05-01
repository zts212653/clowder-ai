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
      return { ...base, toolEvents: [{ id: 'proxy', kind: 'tool_use', name: 'proxy' } as never] };
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
  const existing = findExistingByStableKey(messages, event);
  if (existing) {
    const next = [...messages];
    next[existing.index] = { ...existing.message, content: existing.message.content + chunkContent };
    return next;
  }
  const upgrade = findUpgradableLocalPlaceholder(messages, event);
  if (upgrade) {
    const next = [...messages];
    next[upgrade.index] = withCanonicalUpgrade(
      upgrade.message,
      event,
      {
        content: upgrade.message.content + chunkContent,
      },
      messages,
    );
    return next;
  }
  return [...messages, makePlaceholder(event, chunkContent, messages)];
}

function reduceCallbackFinal(messages: ChatMessage[], event: BubbleEvent): ChatMessage[] {
  const finalContent = (event.payload?.content as string) ?? '';
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
  const upgrade = findUpgradableLocalPlaceholder(messages, event);
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
  if (event.canonicalInvocationId && !findExistingByStableKey(currentMessages, event)) {
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
