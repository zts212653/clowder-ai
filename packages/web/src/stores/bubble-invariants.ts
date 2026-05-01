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

export function deriveBubbleKindFromMessage(msg: ChatMessage): BubbleKind {
  if (msg.type === 'system') return 'system_status';
  const hasTextContent = msg.content.trim().length > 0;
  if (hasTextContent) return 'assistant_text';
  if (msg.extra?.rich?.blocks?.length) return 'rich_block';
  if (msg.thinking) return 'thinking';
  if (msg.toolEvents && msg.toolEvents.length > 0) return 'tool_or_cli';
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
