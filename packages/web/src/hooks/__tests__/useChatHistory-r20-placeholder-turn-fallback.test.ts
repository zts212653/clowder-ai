/**
 * F194 Phase Z3 R20 — Cloud Codex P1: getLocalPlaceholderInvocationId catInvocations
 * fallback must prefer turnInvocationId.
 *
 * Cloud Codex P1 finding (PR #1619 review on R19 444768347):
 * > "When a live local stream bubble has no extra.stream yet, this fallback still
 *    returns catInvocations[catId].invocationId (the parent chain ID). After this
 *    commit, history reconciliation keys use turnInvocationId first, so same-parent
 *    multi-turn flows can miss the intended history match and keep both local+history
 *    bubbles (or reconcile the wrong one). This is most visible when a placeholder is
 *    still unbound during hydration and catInvocations already contains
 *    { invocationId: parent, turnInvocationId: turn }; the local side resolves to
 *    parent while history resolves to turn, breaking stable-key merge."
 *
 * RED before R20: catInv.turnInvocationId set, but fallback returns invocationId (parent).
 * GREEN after R20: fallback returns turnInvocationId when present.
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { getLocalPlaceholderInvocationId } from '../useChatHistory';

const placeholderMsg: ChatMessage = {
  id: 'msg-placeholder-1',
  type: 'assistant',
  catId: 'opus',
  content: '',
  origin: 'stream',
  isStreaming: true,
  timestamp: Date.now(),
  // Crucially: no extra.stream yet (placeholder before invocation_created arrives).
};

describe('F194 Phase Z3 R20 — getLocalPlaceholderInvocationId turn-priority fallback', () => {
  it('returns turnInvocationId when both ids present in catInvocations (cloud Codex P1)', () => {
    const catInvocations = {
      opus: {
        invocationId: 'P-5',
        turnInvocationId: 'T-X',
      },
    };
    const result = getLocalPlaceholderInvocationId(placeholderMsg, catInvocations);
    // GREEN after R20: returns turn id (matches history-side `getBubbleInvocationId` priority).
    // RED before R20: returns 'P-5' (parent) → mismatch with history → split bubbles persist.
    expect(result).toBe('T-X');
  });

  it('falls back to invocationId when turnInvocationId absent (legacy / single-cat case)', () => {
    const catInvocations = {
      opus: {
        invocationId: 'inv-legacy',
      },
    };
    const result = getLocalPlaceholderInvocationId(placeholderMsg, catInvocations);
    expect(result).toBe('inv-legacy');
  });

  it('returns undefined when no catInvocations entry for catId', () => {
    const result = getLocalPlaceholderInvocationId(placeholderMsg, {});
    expect(result).toBeUndefined();
  });

  it('returns extra.stream key when bubble has dual id (turn-priority via getBubbleInvocationId)', () => {
    const boundMsg: ChatMessage = {
      ...placeholderMsg,
      extra: { stream: { invocationId: 'P-5', turnInvocationId: 'T-Y' } },
    };
    const catInvocations = {
      opus: {
        invocationId: 'P-5',
        turnInvocationId: 'T-X',
      },
    };
    const result = getLocalPlaceholderInvocationId(boundMsg, catInvocations);
    // Bubble's own extra.stream wins (T-Y); catInvocations fallback only used for unbound placeholder.
    expect(result).toBe('T-Y');
  });
});
