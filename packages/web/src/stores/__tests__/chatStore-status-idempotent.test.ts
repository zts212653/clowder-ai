import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THREAD_STATE } from '../chat-types';
import { useChatStore } from '../chatStore';

/**
 * Issue #84 — setCatStatus high-frequency "stack explosion"
 *
 * Root cause: setCatStatus creates a new catStatuses object reference on every call,
 * even when the status hasn't changed. During SSE streaming, each text/tool_use/tool_result
 * chunk calls setCatStatus(catId, 'streaming'), producing hundreds of unnecessary
 * Zustand state updates → React re-renders.
 *
 * Fix: bail out (return unchanged state) when catStatuses[catId] === status already.
 */
describe('setCatStatus idempotent guard (#84)', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      threadStates: {},
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-1',
      activeInvocations: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the SAME catStatuses reference when status is unchanged', () => {
    const { setCatStatus } = useChatStore.getState();

    // First call — sets to 'streaming'
    setCatStatus('opus', 'streaming');
    const ref1 = useChatStore.getState().catStatuses;
    expect(ref1.opus).toBe('streaming');

    // Second call — same catId + same status → should NOT create new object
    setCatStatus('opus', 'streaming');
    const ref2 = useChatStore.getState().catStatuses;

    expect(ref2.opus).toBe('streaming');
    // Key assertion: reference equality means Zustand subscribers won't re-render
    expect(ref2).toBe(ref1);
  });

  it('DOES create a new reference when status actually changes', () => {
    const { setCatStatus } = useChatStore.getState();

    setCatStatus('opus', 'streaming');
    const ref1 = useChatStore.getState().catStatuses;

    setCatStatus('opus', 'done');
    const ref2 = useChatStore.getState().catStatuses;

    expect(ref2.opus).toBe('done');
    // Status changed, so new reference is expected
    expect(ref2).not.toBe(ref1);
  });

  it('DOES create a new reference when setting a different cat', () => {
    const { setCatStatus } = useChatStore.getState();

    setCatStatus('opus', 'streaming');
    const ref1 = useChatStore.getState().catStatuses;

    setCatStatus('codex', 'streaming');
    const ref2 = useChatStore.getState().catStatuses;

    expect(ref2.codex).toBe('streaming');
    expect(ref2.opus).toBe('streaming');
    // Different cat, so new reference is expected
    expect(ref2).not.toBe(ref1);
  });

  it('does not trigger Zustand listeners on idempotent calls', () => {
    const { setCatStatus } = useChatStore.getState();

    setCatStatus('opus', 'streaming');

    const listener = vi.fn();
    const unsub = useChatStore.subscribe(listener);

    // 100 rapid-fire calls with same status — should trigger ZERO listener calls
    for (let i = 0; i < 100; i++) {
      setCatStatus('opus', 'streaming');
    }

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });
});

describe('updateThreadCatStatus idempotent guard (#84)', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      threadStates: {
        'bg-thread': { ...DEFAULT_THREAD_STATE, lastActivity: Date.now() },
      },
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-1',
      activeInvocations: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns same threadStates reference for background thread when status unchanged', () => {
    const { updateThreadCatStatus } = useChatStore.getState();

    updateThreadCatStatus('bg-thread', 'opus', 'streaming');
    const ref1 = useChatStore.getState().threadStates;

    updateThreadCatStatus('bg-thread', 'opus', 'streaming');
    const ref2 = useChatStore.getState().threadStates;

    expect(ref2['bg-thread']?.catStatuses?.opus).toBe('streaming');
    expect(ref2).toBe(ref1);
  });

  it('returns same catStatuses reference for active thread when status unchanged', () => {
    const { updateThreadCatStatus } = useChatStore.getState();

    updateThreadCatStatus('thread-1', 'opus', 'streaming');
    const ref1 = useChatStore.getState().catStatuses;

    updateThreadCatStatus('thread-1', 'opus', 'streaming');
    const ref2 = useChatStore.getState().catStatuses;

    expect(ref2.opus).toBe('streaming');
    expect(ref2).toBe(ref1);
  });
});
