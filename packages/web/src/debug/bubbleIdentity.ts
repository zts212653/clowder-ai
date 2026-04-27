import type { ChatMessage } from '@/stores/chat-types';

export type BubbleKind = 'text';
export type BubbleOriginPhase = 'draft' | 'stream' | 'callback' | 'history';

export interface BubbleIdentityDescriptor {
  key?: string;
  catId?: string;
  invocationId?: string;
  bubbleKind: BubbleKind;
  originPhase: BubbleOriginPhase;
  isAuthoritative: boolean;
  isLocalOnly: boolean;
  isUnstable: boolean;
}

export function getBubbleInvocationId(msg: ChatMessage): string | undefined {
  if (msg.extra?.stream?.invocationId) return msg.extra.stream.invocationId;
  if (msg.id.startsWith('draft-')) return msg.id.slice('draft-'.length);
  return undefined;
}

/**
 * F173 A.3 — Deterministic bubble ID derivation.
 *
 * When a stream/callback event has a known invocationId + catId, derive a
 * deterministic bubble ID `msg-{invocationId}-{catId}`. Two handlers (active,
 * background) creating the "same" bubble for the same invocation will land on
 * the same ID — so hydration merge dedups by ID, no ghost survives.
 *
 * Fallback (no invocationId) uses the caller-supplied fallback (typically a
 * timestamp+seq), preserving prior behavior for events that arrive before
 * invocation_created binds the ID.
 */
export function deriveBubbleId(
  invocationId: string | undefined | null,
  catId: string | undefined | null,
  fallback: () => string,
): string {
  if (invocationId && catId) return `msg-${invocationId}-${catId}`;
  return fallback();
}

export function getBubbleOriginPhase(msg: ChatMessage): BubbleOriginPhase {
  if (msg.id.startsWith('draft-')) return 'draft';
  if (msg.origin === 'stream' || msg.isStreaming) return 'stream';
  if (msg.origin === 'callback') return 'callback';
  return 'history';
}

export function getBubbleIdentityKey(msg: ChatMessage): string | undefined {
  if (msg.type !== 'assistant' || !msg.catId) return undefined;
  const invocationId = getBubbleInvocationId(msg);
  if (!invocationId) return undefined;
  return `${msg.catId}:${invocationId}:text`;
}

export function describeBubbleIdentity(msg: ChatMessage): BubbleIdentityDescriptor {
  const originPhase = getBubbleOriginPhase(msg);
  const isLocalOnly = originPhase === 'draft' || originPhase === 'stream';
  return {
    key: getBubbleIdentityKey(msg),
    catId: msg.catId,
    invocationId: getBubbleInvocationId(msg),
    bubbleKind: 'text',
    originPhase,
    isAuthoritative: !isLocalOnly,
    isLocalOnly,
    isUnstable: isLocalOnly,
  };
}

export function shouldForceReplaceHydrationForCachedMessages(messages: ChatMessage[]): boolean {
  const seenIdentityKeys = new Set<string>();
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;

    const identity = describeBubbleIdentity(msg);
    if (identity.isUnstable) return true;

    const identityKey = identity.key;
    if (!identityKey) continue;
    if (seenIdentityKeys.has(identityKey)) return true;
    seenIdentityKeys.add(identityKey);
  }
  return false;
}
