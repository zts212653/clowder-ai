import type { ConversationViewPreferenceSnapshot } from '@cat-cafe/shared';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatReadingPort } from '@/components/thread-chat/useThreadChatReadingPort';
import type { ChatMessage } from '@/stores/chat-types';
import {
  __resetChatScrollMemoryForTest,
  captureChatReadingRef,
  readChatReadingRef,
  readChatScrollState,
  saveChatScrollState,
} from '@/utils/chat-scroll-memory';
import type {
  ConversationViewPreferenceBeforeCommit,
  ConversationViewPreferenceController,
} from '../useConversationViewPreference';
import {
  projectedConversationViewKey,
  useConversationViewReadingCheckpoint,
} from '../useConversationViewReadingCheckpoint';

const group: ConversationViewPreferenceSnapshot = {
  stored: null,
  effective: { mode: 'group' },
  source: 'product',
};
const cat: ConversationViewPreferenceSnapshot = {
  stored: { mode: 'cat', catId: 'opus55' },
  effective: { mode: 'cat', catId: 'opus55' },
  source: 'thread',
};
const messages: ChatMessage[] = [
  {
    id: 'response-opus',
    type: 'assistant',
    catId: 'opus55',
    from: { kind: 'agent', catId: 'opus55' },
    content: '看到了',
    timestamp: 20,
    lifecycle: {
      kind: 'response',
      orderKey: '18:response-opus',
      targetId: 'opus55',
      invocationId: 'inv-opus',
      startedAt: 18,
      status: 'completed',
      inputMessageIds: [],
      inputEntryIds: [],
      completedAt: 20,
    },
  },
];

describe('conversation view reading checkpoint', () => {
  let host: HTMLDivElement;
  let root: Root;
  let snapshot = group;
  let threadId = 'thread-view';
  let projectionMessages = messages;
  let capturedReadingRef = 'group-reading-ref';
  const listeners = new Set<ConversationViewPreferenceBeforeCommit>();
  const captureReadingRef = vi.fn(() => ({ ref: capturedReadingRef, persisted: true }));
  const restoreReadingRef = vi.fn(async () => ({
    status: 'settled' as const,
    exact: true,
    position: { top: 120, anchor: 'bottom' as const },
  }));
  const releaseReadingRef = vi.fn(() => true);
  const port: ChatReadingPort = {
    threadId: 'thread-view',
    ownerId: 'owner-view',
    captureReadingRef,
    restoreReadingRef,
    releaseReadingRef,
    navigateToMessage: vi.fn(),
  };
  const subscribeBeforeCommit = (listener: ConversationViewPreferenceBeforeCommit) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  function Harness() {
    const controller: ConversationViewPreferenceController = {
      snapshot,
      loading: false,
      saving: false,
      error: null,
      save: vi.fn(),
      subscribeBeforeCommit,
    };
    const reading = useConversationViewReadingCheckpoint({
      threadId,
      controller,
      messages: projectionMessages,
      queue: [],
    });
    useLayoutEffect(() => {
      reading.setReadingPort(port);
      return () => reading.setReadingPort(null);
    }, [reading.setReadingPort]);
    return <output data-view-key={reading.visibleViewKey} />;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    snapshot = group;
    threadId = 'thread-view';
    projectionMessages = messages;
    capturedReadingRef = 'group-reading-ref';
    listeners.clear();
    captureReadingRef.mockClear();
    restoreReadingRef.mockClear();
    releaseReadingRef.mockClear();
    localStorage.clear();
    __resetChatScrollMemoryForTest();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    __resetChatScrollMemoryForTest();
    vi.unstubAllGlobals();
  });

  async function commit(next: ConversationViewPreferenceSnapshot) {
    const previous = snapshot;
    await act(async () => {
      for (const listener of listeners) listener(previous, next);
      snapshot = next;
      root.render(<Harness />);
      await Promise.resolve();
    });
  }

  function capturePersistedRef(position: { top: number; anchor: 'bottom' }): string {
    const captured = captureChatReadingRef({ threadId, position });
    if (!captured) throw new Error('expected a persisted reading reference');
    return captured.ref;
  }

  it('captures group reading before the cat projection and restores that immutable checkpoint on return', async () => {
    await act(async () => root.render(<Harness />));

    await commit(cat);
    expect(host.querySelector('output')?.getAttribute('data-view-key')).toBe('cat:opus55');
    expect(captureReadingRef).toHaveBeenCalledOnce();
    expect(restoreReadingRef).not.toHaveBeenCalled();

    await commit(group);
    expect(host.querySelector('output')?.getAttribute('data-view-key')).toBe('group');
    expect(restoreReadingRef).toHaveBeenCalledWith('group-reading-ref', expect.any(AbortSignal));
    expect(releaseReadingRef).toHaveBeenCalledWith('group-reading-ref');
  });

  it('does not treat an unavailable stored cat as a visible transition', () => {
    expect(projectedConversationViewKey(cat.effective, [], [])).toBe('group');
    expect(projectedConversationViewKey(cat.effective, messages, [])).toBe('cat:opus55');
  });

  it('releases an old thread checkpoint instead of carrying it across navigation', async () => {
    capturedReadingRef = capturePersistedRef({ top: 300, anchor: 'bottom' });
    await act(async () => root.render(<Harness />));
    await commit(cat);
    expect(captureReadingRef).toHaveBeenCalledOnce();

    await act(async () => {
      threadId = 'thread-other';
      snapshot = group;
      root.render(<Harness />);
    });

    expect(readChatReadingRef(capturedReadingRef)).toBeUndefined();
    expect(restoreReadingRef).not.toHaveBeenCalled();
  });

  it('writes the immutable group checkpoint back before leaving a thread from a single-cat view', async () => {
    const groupPosition = { top: 420, anchor: 'bottom' as const };
    capturedReadingRef = capturePersistedRef(groupPosition);
    saveChatScrollState(threadId, groupPosition);
    await act(async () => root.render(<Harness />));
    await commit(cat);

    saveChatScrollState(threadId, { top: 24, anchor: 'bottom' });
    await act(async () => {
      threadId = 'thread-other';
      snapshot = group;
      root.render(<Harness />);
    });

    expect(readChatScrollState('thread-view')).toEqual(groupPosition);
    expect(readChatReadingRef(capturedReadingRef)).toBeUndefined();
  });

  it('captures before a stored cat preference even when its history evidence arrives later', async () => {
    projectionMessages = [];
    await act(async () => root.render(<Harness />));
    await commit(cat);
    expect(host.querySelector('output')?.getAttribute('data-view-key')).toBe('group');
    expect(captureReadingRef).toHaveBeenCalledOnce();

    await act(async () => {
      projectionMessages = messages;
      root.render(<Harness />);
    });
    expect(host.querySelector('output')?.getAttribute('data-view-key')).toBe('cat:opus55');

    await commit(group);
    expect(restoreReadingRef).toHaveBeenCalledWith('group-reading-ref', expect.any(AbortSignal));
  });
});
