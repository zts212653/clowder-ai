import { describe, expect, it, vi } from 'vitest';
import type { NavigateEvent } from '@/hooks/useWorkspaceNavigate';
import {
  clearPendingWorkspaceNavigation,
  consumePendingWorkspaceNavigation,
  deliverWorkspaceNavigateEvent,
  getPendingWorkspaceNavigation,
  queuePendingWorkspaceNavigation,
  type WorkspaceNavigationStorage,
} from '@/hooks/workspace-navigation-pending';

class MemoryStorage implements WorkspaceNavigationStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const event = (threadId: string, eventId: string, path = 'docs/guide.md'): NavigateEvent => ({
  action: 'open',
  worktreeId: 'cat-cafe',
  path,
  line: 42,
  threadId,
  eventId,
});

describe('pending Workspace navigation', () => {
  it('keeps the latest event per thread without deleting another thread', () => {
    const storage = new MemoryStorage();
    expect(queuePendingWorkspaceNavigation(storage, event('thread-a', 'event-a1'))).toBe(true);
    expect(queuePendingWorkspaceNavigation(storage, event('thread-b', 'event-b1'))).toBe(true);
    expect(queuePendingWorkspaceNavigation(storage, event('thread-a', 'event-a2', 'docs/latest.md'))).toBe(true);

    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toEqual(event('thread-a', 'event-a2', 'docs/latest.md'));
    expect(getPendingWorkspaceNavigation(storage, 'thread-b')).toEqual(event('thread-b', 'event-b1'));
  });

  it('clears only the matching event id after apply', () => {
    const storage = new MemoryStorage();
    queuePendingWorkspaceNavigation(storage, event('thread-a', 'event-new'));

    clearPendingWorkspaceNavigation(storage, 'thread-a', 'event-stale');
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')?.eventId).toBe('event-new');

    clearPendingWorkspaceNavigation(storage, 'thread-a', 'event-new');
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toBeNull();
  });

  it('applies immediately only when the intended chat is visible and unlocked', () => {
    const apply = vi.fn(() => true);
    const persist = vi.fn(() => true);

    expect(
      deliverWorkspaceNavigateEvent({
        data: event('thread-a', 'event-a1'),
        activeThreadId: 'thread-a',
        isChatRoute: true,
        isWorkspaceVisible: true,
        presentationLocked: false,
        apply,
        persist,
      }),
    ).toEqual({ status: 'applied', eventId: 'event-a1' });
    expect(apply).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports blocked when the apply boundary rejects navigation after the delivery precheck', () => {
    const apply = vi.fn(() => false);
    const persist = vi.fn(() => true);

    expect(
      deliverWorkspaceNavigateEvent({
        data: event('thread-a', 'event-a1'),
        activeThreadId: 'thread-a',
        isChatRoute: true,
        isWorkspaceVisible: true,
        presentationLocked: false,
        apply,
        persist,
      }),
    ).toEqual({ status: 'blocked', eventId: 'event-a1' });
    expect(apply).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    {
      activeThreadId: 'thread-b',
      isChatRoute: true,
      isWorkspaceVisible: true,
      reason: 'thread_inactive',
    },
    {
      activeThreadId: 'thread-a',
      isChatRoute: false,
      isWorkspaceVisible: true,
      reason: 'non_chat_route',
    },
    {
      activeThreadId: 'thread-a',
      isChatRoute: true,
      isWorkspaceVisible: false,
      reason: 'narrow_viewport',
    },
  ] as const)('queues when the target cannot currently be displayed: $reason', (input) => {
    const apply = vi.fn(() => true);
    const persist = vi.fn(() => true);

    expect(
      deliverWorkspaceNavigateEvent({
        data: event('thread-a', 'event-a1'),
        ...input,
        presentationLocked: false,
        apply,
        persist,
      }),
    ).toEqual({ status: 'queued', eventId: 'event-a1', reason: input.reason });
    expect(apply).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('blocks a new event when presentation lock is active', () => {
    const apply = vi.fn(() => true);
    const persist = vi.fn(() => true);

    expect(
      deliverWorkspaceNavigateEvent({
        data: event('thread-a', 'event-a1'),
        activeThreadId: 'thread-a',
        isChatRoute: true,
        isWorkspaceVisible: true,
        presentationLocked: true,
        apply,
        persist,
      }),
    ).toEqual({ status: 'blocked', eventId: 'event-a1', reason: 'presentation_lock' });
    expect(apply).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('blocks rather than lying about a queue when session storage is unavailable', () => {
    expect(
      deliverWorkspaceNavigateEvent({
        data: event('thread-a', 'event-a1'),
        activeThreadId: 'thread-b',
        isChatRoute: true,
        isWorkspaceVisible: true,
        presentationLocked: false,
        apply: () => true,
        persist: () => false,
      }),
    ).toEqual({ status: 'blocked', eventId: 'event-a1', reason: 'persistence_unavailable' });
  });

  it('preserves a queued event while locked and deletes it only after a successful apply', () => {
    const storage = new MemoryStorage();
    queuePendingWorkspaceNavigation(storage, event('thread-a', 'event-a1'));

    expect(
      consumePendingWorkspaceNavigation({
        storage,
        threadId: 'thread-a',
        canDisplay: true,
        presentationLocked: true,
        apply: () => true,
      }),
    ).toBe(false);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')?.eventId).toBe('event-a1');

    expect(
      consumePendingWorkspaceNavigation({
        storage,
        threadId: 'thread-a',
        canDisplay: true,
        presentationLocked: false,
        apply: () => true,
      }),
    ).toBe(true);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toBeNull();
  });

  it('consumes a queued knowledge-feed event while Presentation Lock is active', () => {
    const storage = new MemoryStorage();
    const knowledgeFeed: NavigateEvent = {
      ...event('thread-a', 'event-knowledge-feed'),
      action: 'knowledge-feed',
      path: '',
    };
    queuePendingWorkspaceNavigation(storage, knowledgeFeed);
    const apply = vi.fn(() => true);

    expect(
      consumePendingWorkspaceNavigation({
        storage,
        threadId: 'thread-a',
        canDisplay: true,
        presentationLocked: true,
        apply,
      }),
    ).toBe(true);
    expect(apply).toHaveBeenCalledWith(knowledgeFeed);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toBeNull();
  });
});
