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

/**
 * F194 Phase Z3: dual id contract.
 *   Bubble identity priority:
 *     1. `extra.stream.turnInvocationId` (per-cat-turn invocation, Z3 new — bubble identity SoT)
 *     2. `extra.stream.invocationId` (parent/chain invocation, legacy fallback for old messages)
 *     3. draft message id slice
 *
 * Why: same parent A2A chain `opus → codex → opus` 共用 `extra.stream.invocationId=parentId`，
 * 如果 bubble identity 用 parent id，第 1 个和第 3 个 opus turn 会被 reducer/merge 视为同一气泡 →
 * cancel 按钮消失 + 第 3 个 opus 失踪（铲屎官 catch 2026-05-09 17:32, 砚砚 root cause analysis）。
 */
export function getBubbleInvocationId(msg: ChatMessage): string | undefined {
  if (msg.extra?.stream?.turnInvocationId) return msg.extra.stream.turnInvocationId;
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
