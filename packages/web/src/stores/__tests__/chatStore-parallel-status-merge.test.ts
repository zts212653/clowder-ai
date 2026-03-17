/**
 * Tests for #117: ParallelStatusBar only showing single cat.
 *
 * Root cause: setTargetCats uses replace semantics — when multi-mention
 * dispatches emit per-cat intent_mode events, each one overwrites the
 * previous, leaving only the last cat visible.
 *
 * Expected: merge semantics — subsequent setTargetCats calls should union
 * with existing targetCats and preserve already-set catStatuses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chatStore setTargetCats merge semantics (#117)', () => {
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
      currentThreadId: 'thread-a',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  it('initial setTargetCats with 3 cats sets all to pending', () => {
    useChatStore.getState().setTargetCats(['opus', 'codex', 'opencode']);
    const state = useChatStore.getState();
    expect(state.targetCats).toEqual(['opus', 'codex', 'opencode']);
    expect(state.catStatuses).toEqual({
      opus: 'pending',
      codex: 'pending',
      opencode: 'pending',
    });
  });

  it('subsequent setTargetCats with single cat merges, not replaces', () => {
    // Simulate initial 3-cat intent_mode from messages.ts
    useChatStore.getState().setTargetCats(['opus', 'codex', 'opencode']);

    // Simulate per-cat intent_mode from callback-multi-mention-routes.ts
    // This should MERGE, not replace
    useChatStore.getState().setTargetCats(['codex']);

    const state = useChatStore.getState();
    // All 3 cats should still be present
    expect(state.targetCats).toContain('opus');
    expect(state.targetCats).toContain('codex');
    expect(state.targetCats).toContain('opencode');
    expect(state.targetCats.length).toBe(3);
  });

  it('preserves existing catStatuses when merging new cats', () => {
    // Set initial 3 cats
    useChatStore.getState().setTargetCats(['opus', 'codex', 'opencode']);
    // Simulate opus starting to respond
    useChatStore.getState().setCatStatus('opus', 'streaming');

    // Per-cat intent_mode for codex arrives
    useChatStore.getState().setTargetCats(['codex']);

    const state = useChatStore.getState();
    // opus status should be preserved as 'streaming', not reset to 'pending'
    expect(state.catStatuses.opus).toBe('streaming');
    // codex should remain 'pending' (or be refreshed to 'pending')
    expect(state.catStatuses.codex).toBe('pending');
    // opencode should still exist
    expect(state.catStatuses.opencode).toBe('pending');
  });

  it('adds genuinely new cats not in existing targetCats', () => {
    useChatStore.getState().setTargetCats(['opus', 'codex']);

    // A new cat appears (e.g. user sends another mention while parallel is running)
    useChatStore.getState().setTargetCats(['opencode']);

    const state = useChatStore.getState();
    expect(state.targetCats).toContain('opus');
    expect(state.targetCats).toContain('codex');
    expect(state.targetCats).toContain('opencode');
  });
});

describe('chatStore setThreadTargetCats merge semantics (#117)', () => {
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
      currentThreadId: 'thread-a',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  it('merges targetCats for active thread (matches currentThreadId)', () => {
    // Initial 3-cat set via active thread path
    useChatStore.getState().setThreadTargetCats('thread-a', ['opus', 'codex', 'opencode']);
    // Per-cat emission
    useChatStore.getState().setThreadTargetCats('thread-a', ['codex']);

    const state = useChatStore.getState();
    expect(state.targetCats).toContain('opus');
    expect(state.targetCats).toContain('codex');
    expect(state.targetCats).toContain('opencode');
  });

  it('merges targetCats for background thread (threadStates)', () => {
    // Background thread scenario
    useChatStore.getState().setThreadTargetCats('thread-b', ['opus', 'codex', 'opencode']);
    // Per-cat emission
    useChatStore.getState().setThreadTargetCats('thread-b', ['codex']);

    const threadState = useChatStore.getState().threadStates['thread-b'];
    expect(threadState?.targetCats).toContain('opus');
    expect(threadState?.targetCats).toContain('codex');
    expect(threadState?.targetCats).toContain('opencode');
  });

  it('preserves catStatuses for background thread when merging', () => {
    useChatStore.getState().setThreadTargetCats('thread-b', ['opus', 'codex']);
    useChatStore.getState().updateThreadCatStatus('thread-b', 'opus', 'streaming');

    // Per-cat emission for codex
    useChatStore.getState().setThreadTargetCats('thread-b', ['codex']);

    const threadState = useChatStore.getState().threadStates['thread-b'];
    expect(threadState?.catStatuses?.opus).toBe('streaming');
    expect(threadState?.catStatuses?.codex).toBe('pending');
  });
});

describe('setTargetCats empty-array clear semantics (#117 P1 regression)', () => {
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
      currentThreadId: 'thread-a',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  it('setTargetCats([]) clears all cats and statuses', () => {
    useChatStore.getState().setTargetCats(['opus', 'codex', 'opencode']);
    expect(useChatStore.getState().targetCats.length).toBe(3);

    useChatStore.getState().setTargetCats([]);
    const state = useChatStore.getState();
    expect(state.targetCats).toEqual([]);
    expect(state.catStatuses).toEqual({});
  });

  it('setThreadTargetCats(activeThread, []) clears flat state', () => {
    useChatStore.getState().setThreadTargetCats('thread-a', ['opus']);
    expect(useChatStore.getState().targetCats).toContain('opus');

    useChatStore.getState().setThreadTargetCats('thread-a', []);
    const state = useChatStore.getState();
    expect(state.targetCats).toEqual([]);
    expect(state.catStatuses).toEqual({});
  });

  it('setThreadTargetCats(bgThread, []) clears background thread state', () => {
    useChatStore.getState().setThreadTargetCats('thread-b', ['opus', 'codex']);

    useChatStore.getState().setThreadTargetCats('thread-b', []);
    const threadState = useChatStore.getState().threadStates['thread-b'];
    expect(threadState?.targetCats).toEqual([]);
    expect(threadState?.catStatuses).toEqual({});
  });
});

describe('replaceThreadTargetCats replace semantics (#117 P1 queue hydration)', () => {
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
      currentThreadId: 'thread-a',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  it('stale superset + authoritative subset → converges to subset (active thread)', () => {
    // Stale local state has ['opus', 'codex'] from earlier merge
    useChatStore.getState().setTargetCats(['opus', 'codex']);
    useChatStore.getState().setCatStatus('opus', 'streaming');

    // Server says only ['codex'] is active — must REPLACE, not merge
    useChatStore.getState().replaceThreadTargetCats('thread-a', ['codex']);

    const state = useChatStore.getState();
    expect(state.targetCats).toEqual(['codex']);
    // opus must be gone — no ghost cat
    expect(state.catStatuses).not.toHaveProperty('opus');
    expect(state.catStatuses.codex).toBe('pending');
  });

  it('stale superset + authoritative subset → converges to subset (background thread)', () => {
    // Stale local state for background thread
    useChatStore.getState().setThreadTargetCats('thread-b', ['opus', 'codex', 'opencode']);
    useChatStore.getState().updateThreadCatStatus('thread-b', 'opus', 'streaming');

    // Server says only ['codex'] is active — must REPLACE
    useChatStore.getState().replaceThreadTargetCats('thread-b', ['codex']);

    const threadState = useChatStore.getState().threadStates['thread-b'];
    expect(threadState?.targetCats).toEqual(['codex']);
    expect(threadState?.catStatuses).not.toHaveProperty('opus');
    expect(threadState?.catStatuses).not.toHaveProperty('opencode');
    expect(threadState?.catStatuses?.codex).toBe('pending');
  });

  it('replaceThreadTargetCats([]) clears all cats (same as setThreadTargetCats([]))', () => {
    useChatStore.getState().setThreadTargetCats('thread-a', ['opus', 'codex']);

    useChatStore.getState().replaceThreadTargetCats('thread-a', []);

    const state = useChatStore.getState();
    expect(state.targetCats).toEqual([]);
    expect(state.catStatuses).toEqual({});
  });

  it('replace does not merge — fresh set each time', () => {
    // First replace sets ['opus']
    useChatStore.getState().replaceThreadTargetCats('thread-a', ['opus']);
    expect(useChatStore.getState().targetCats).toEqual(['opus']);

    // Second replace sets ['codex'] — opus must be gone
    useChatStore.getState().replaceThreadTargetCats('thread-a', ['codex']);
    const state = useChatStore.getState();
    expect(state.targetCats).toEqual(['codex']);
    expect(state.catStatuses).not.toHaveProperty('opus');
  });
});
