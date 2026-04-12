import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THREAD_STATE } from '../chat-types';
import { useChatStore } from '../chatStore';

/**
 * F118 D2: spawn_started socket event handling.
 *
 * Tests the store-level state mutations that useSocket.ts performs
 * when receiving a spawn_started event. Covers:
 * - Active thread: setCatStatus('spawning') for each target cat
 * - Background thread: setThreadLoading + setThreadTargetCats
 * - Idempotency: duplicate spawn_started doesn't cause jitter
 */
describe('spawn_started state mutations', () => {
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

  it('active thread: setCatStatus sets spawning for each target cat', () => {
    const { setCatStatus } = useChatStore.getState();

    // Simulate what useSocket spawn_started handler does for active thread
    for (const catId of ['opus', 'codex']) {
      setCatStatus(catId, 'spawning');
    }

    const { catStatuses } = useChatStore.getState();
    expect(catStatuses.opus).toBe('spawning');
    expect(catStatuses.codex).toBe('spawning');
  });

  it('background thread: setThreadLoading + setThreadTargetCats', () => {
    const store = useChatStore.getState();

    // Simulate what useSocket spawn_started handler does for background thread
    store.setThreadLoading('bg-thread', true);
    store.setThreadHasActiveInvocation('bg-thread', true);
    store.setThreadTargetCats('bg-thread', ['opus', 'codex']);

    const ts = useChatStore.getState().threadStates['bg-thread'];
    expect(ts?.isLoading).toBe(true);
    expect(ts?.hasActiveInvocation).toBe(true);
    expect(ts?.targetCats).toEqual(['opus', 'codex']);
  });

  it('idempotent: duplicate setCatStatus spawning does not trigger listener', () => {
    const { setCatStatus } = useChatStore.getState();

    setCatStatus('opus', 'spawning');

    const listener = vi.fn();
    const unsub = useChatStore.subscribe(listener);

    // Duplicate calls — should not trigger
    setCatStatus('opus', 'spawning');
    setCatStatus('opus', 'spawning');

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('spawning → streaming transition works correctly', () => {
    const { setCatStatus } = useChatStore.getState();

    setCatStatus('opus', 'spawning');
    expect(useChatStore.getState().catStatuses.opus).toBe('spawning');

    // intent_mode arrives → agent_message arrives → streaming
    setCatStatus('opus', 'streaming');
    expect(useChatStore.getState().catStatuses.opus).toBe('streaming');
  });
});
