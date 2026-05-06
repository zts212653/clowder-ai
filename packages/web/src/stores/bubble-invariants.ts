import type {
  BubbleEventType,
  BubbleInvariantViolation,
  BubbleKind,
  BubbleOriginPhase,
  BubbleSourcePath,
  BubbleStableIdentity,
  BubbleViolationKind,
} from '@cat-cafe/shared';
import { getBubbleInvocationId } from '@/debug/bubbleIdentity';
import type { ChatMessage } from './chat-types';

type BubbleInvariantContext = {
  threadId: string;
  eventType: BubbleEventType;
  sourcePath: BubbleSourcePath;
  originPhase?: BubbleOriginPhase;
  timestamp?: number;
  seq?: number | null;
};

type IncomingBubbleContext = BubbleInvariantContext;

const phaseRank: Record<BubbleOriginPhase, number> = {
  'draft/local': 0,
  stream: 1,
  'callback/history': 2,
};

function identityKey(identity: BubbleStableIdentity): string {
  return `${identity.threadId}:${identity.actorId}:${identity.canonicalInvocationId}:${identity.bubbleKind}`;
}

function isUiCompatStreamingAssistantContainer(msg: ChatMessage, invocationId: string | undefined): boolean {
  if (msg.type !== 'assistant') return false;
  if (!msg.catId) return false;
  if (!invocationId) return false;
  if (msg.origin !== 'stream') return false;

  // Active path `ensureActiveAssistantMessage` creates the canonical
  // `msg-{invocationId}-{catId}` assistant container before text/tools may
  // arrive. Background thinking fallback uses `bg-think-*` for the same
  // UI-compat role. These remain assistant_text containers even while they only
  // have thinking/tool sub-events, including the finalized-but-not-yet-hydrated
  // live window where late stdout chunks can still arrive. True ADR thinking
  // bubbles use distinct ids such as `msg-{invocationId}-{catId}-thinking` and
  // stay `thinking`.
  if (msg.id === `msg-${invocationId}-${msg.catId}`) return true;
  return msg.id.startsWith('bg-think-');
}

export function deriveBubbleKindFromMessage(msg: ChatMessage): BubbleKind {
  if (msg.type === 'system') return 'system_status';
  const invocationId = getBubbleInvocationId(msg);
  const hasTextContent = msg.content.trim().length > 0;
  if (hasTextContent) return 'assistant_text';
  if (msg.extra?.rich?.blocks?.length) return 'rich_block';
  if (msg.thinking) {
    if (isUiCompatStreamingAssistantContainer(msg, invocationId)) return 'assistant_text';
    return 'thinking';
  }
  if (msg.toolEvents && msg.toolEvents.length > 0) {
    // F183 Phase B1.6 (砚砚 R2 P1) — empty content + toolEvents 是歧义态：
    // (a) UI-compat 的 streaming assistant container（active path 的 ensure
    //     ActiveAssistantMessage seed 后被 reduceToolEvent append toolEvent
    //     的 transient 状态）—— 这条 bubble 已绑 stream invocation，仍在
    //     streaming 中，是 "正在进行中的 assistant_text 气泡，已积累 tool
    //     sub-events 但还没收 text"，应保 assistant_text 让后续 stream_chunk
    //     能 stable-key 命中同一 bubble 不触发 canonical-split。
    // (b) Pure ADR-033 tool_or_cli bubble（finalize / callback / 没绑 stream
    //     的纯独立 tool 显示气泡）—— 仍归 tool_or_cli。
    // disambiguation: 只有 UI-compat streaming assistant container 才视作
    // assistant_text；这是窄 guard，避免影响 invariants 既有 "keeps pure
    // tool-only" / "canonical-split for tool_or_cli incoming" 等场景。
    if (isUiCompatStreamingAssistantContainer(msg, invocationId)) {
      return 'assistant_text';
    }
    return 'tool_or_cli';
  }
  return 'assistant_text';
}

export function deriveActorIdFromMessage(msg: ChatMessage): string | undefined {
  if (msg.catId) return msg.catId;
  if (msg.type === 'system') return 'system';
  return undefined;
}

export function deriveBubbleOriginPhase(msg: ChatMessage): BubbleOriginPhase | undefined {
  if (msg.id.startsWith('draft-')) return 'draft/local';
  if (msg.origin === 'stream' || msg.isStreaming) return 'stream';
  if (msg.origin === 'callback' || msg.origin === 'briefing') return 'callback/history';
  return undefined;
}

export function deriveBubbleStableIdentity(msg: ChatMessage, threadId: string): BubbleStableIdentity | undefined {
  const actorId = deriveActorIdFromMessage(msg);
  const canonicalInvocationId = getBubbleInvocationId(msg);
  if (!actorId || !canonicalInvocationId) return undefined;
  return {
    threadId,
    actorId,
    canonicalInvocationId,
    bubbleKind: deriveBubbleKindFromMessage(msg),
  };
}

function makeViolation(
  identity: BubbleStableIdentity,
  context: BubbleInvariantContext,
  violationKind: BubbleViolationKind,
  existingMessageId: string | null,
  incomingMessageId: string | null,
  originPhase: BubbleOriginPhase,
): BubbleInvariantViolation {
  return {
    ...identity,
    eventType: context.eventType,
    originPhase,
    sourcePath: context.sourcePath,
    existingMessageId,
    incomingMessageId,
    seq: context.seq ?? null,
    recoveryAction: violationKind === 'canonical-split' ? 'sot-override' : 'quarantine',
    violationKind,
    timestamp: context.timestamp ?? Date.now(),
  };
}

export function findBubbleStoreInvariantViolations(
  messages: ChatMessage[],
  context: BubbleInvariantContext,
): BubbleInvariantViolation[] {
  const seen = new Map<string, { identity: BubbleStableIdentity; message: ChatMessage }>();
  const violations: BubbleInvariantViolation[] = [];

  for (const message of messages) {
    const identity = deriveBubbleStableIdentity(message, context.threadId);
    if (!identity) continue;

    const key = identityKey(identity);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { identity, message });
      continue;
    }

    violations.push(
      makeViolation(
        identity,
        context,
        'duplicate',
        existing.message.id,
        message.id,
        deriveBubbleOriginPhase(message) ?? context.originPhase ?? 'stream',
      ),
    );
  }

  return violations;
}

export function validateIncomingBubbleEvent(
  existingMessages: ChatMessage[],
  incoming: ChatMessage,
  context: IncomingBubbleContext,
): BubbleInvariantViolation | null {
  const incomingIdentity = deriveBubbleStableIdentity(incoming, context.threadId);
  if (!incomingIdentity) return null;
  const incomingKey = identityKey(incomingIdentity);
  const incomingPhase = context.originPhase ?? deriveBubbleOriginPhase(incoming) ?? 'stream';

  for (const existing of existingMessages) {
    const existingIdentity = deriveBubbleStableIdentity(existing, context.threadId);
    if (!existingIdentity) continue;
    const existingKey = identityKey(existingIdentity);

    if (existing.id === incoming.id && existingKey !== incomingKey) {
      return makeViolation(incomingIdentity, context, 'canonical-split', existing.id, incoming.id, incomingPhase);
    }

    if (existingKey !== incomingKey) continue;

    const existingPhase = deriveBubbleOriginPhase(existing);
    if (existingPhase && phaseRank[incomingPhase] < phaseRank[existingPhase]) {
      return makeViolation(incomingIdentity, context, 'phase-regression', existing.id, incoming.id, incomingPhase);
    }
  }

  return null;
}

export function assertNoBubbleInvariantViolations(messages: ChatMessage[], context: BubbleInvariantContext): void {
  const violations = findBubbleStoreInvariantViolations(messages, context);
  const [first] = violations;
  if (!first) return;
  throw new Error(
    `duplicate stable bubble identity: ${first.threadId}/${first.actorId}/${first.canonicalInvocationId}/${first.bubbleKind}`,
  );
}
