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
  it('reports successful removal only for the matching durable pending event', () => {
    const storage = new MemoryStorage();
    queuePendingWorkspaceNavigation(storage, event('thread-a', 'event-current'));
    expect(clearPendingWorkspaceNavigation(storage, 'thread-a', 'event-stale')).toBe(false);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')?.eventId).toBe('event-current');
    expect(clearPendingWorkspaceNavigation(storage, 'thread-a', 'event-current')).toBe(true);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toBeNull();
  });

  it('reports a failed clear and retains the pending request and other conversation when persistence rejects it', () => {
    const storage = new MemoryStorage();
    const a = event('thread-a', 'event-a');
    const b = event('thread-b', 'event-b');
    queuePendingWorkspaceNavigation(storage, a, { requiresExplicitAction: true });
    queuePendingWorkspaceNavigation(storage, b);
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(clearPendingWorkspaceNavigation(storage, 'thread-a', a.eventId)).toBe(false);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toEqual(a);
    expect(getPendingWorkspaceNavigation(storage, 'thread-b')).toEqual(b);
  });

  it('does not report a queued event consumed when apply succeeds but durable removal fails', () => {
    const storage = new MemoryStorage();
    const data = event('thread-a', 'event-a');
    queuePendingWorkspaceNavigation(storage, data);
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    const apply = vi.fn(() => true);
    expect(
      consumePendingWorkspaceNavigation({
        storage,
        threadId: 'thread-a',
        canDisplay: true,
        presentationLocked: false,
        apply,
      }),
    ).toBe(false);
    expect(apply).toHaveBeenCalledWith(data);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toEqual(data);
  });

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

  it('retains a blocked lock request for explicit Ignore or Replace without applying it', () => {
    const storage = new MemoryStorage();
    const apply = vi.fn(() => true);
    const persist = vi.fn((data: NavigateEvent) => queuePendingWorkspaceNavigation(storage, data));
    const data = event('thread-a', 'event-a1');

    expect(
      deliverWorkspaceNavigateEvent({
        data,
        activeThreadId: 'thread-a',
        isChatRoute: true,
        isWorkspaceVisible: true,
        presentationLocked: true,
        apply,
        persist,
      }),
    ).toEqual({ status: 'blocked', eventId: 'event-a1', reason: 'presentation_lock' });
    expect(apply).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith(data);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toEqual(data);
  });

  it.each([false, true])('reports unavailable persistence even with presentation lock=%s', (presentationLocked) => {
    expect(
      deliverWorkspaceNavigateEvent({
        data: event('thread-a', 'event-a1'),
        activeThreadId: 'thread-b',
        isChatRoute: true,
        isWorkspaceVisible: true,
        presentationLocked,
        apply: () => true,
        persist: () => false,
      }),
    ).toEqual({ status: 'blocked', eventId: 'event-a1', reason: 'persistence_unavailable' });
  });

  it('never auto-applies a lock request after unlock or reload while an explicit decision is still owed', () => {
    const storage = new MemoryStorage();
    const data = event('thread-a', 'event-locked');
    queuePendingWorkspaceNavigation(storage, data, { requiresExplicitAction: true });
    const apply = vi.fn(() => true);

    expect(
      consumePendingWorkspaceNavigation({
        storage,
        threadId: 'thread-a',
        canDisplay: true,
        presentationLocked: false,
        apply,
      }),
    ).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toEqual(data);
  });

  it('reads existing v1 automatic requests without requiring a new decision', () => {
    const storage = new MemoryStorage();
    const data = event('thread-a', 'event-legacy');
    storage.setItem(
      'cat-cafe:pending-workspace-navigation:v1',
      JSON.stringify({ version: 1, byThread: { 'thread-a': data } }),
    );
    const apply = vi.fn(() => true);

    expect(
      consumePendingWorkspaceNavigation({
        storage,
        threadId: 'thread-a',
        canDisplay: true,
        presentationLocked: false,
        apply,
      }),
    ).toBe(true);
    expect(apply).toHaveBeenCalledWith(data);
    expect(getPendingWorkspaceNavigation(storage, 'thread-a')).toBeNull();
  });

  it('does not attach an older blocked decision to the next automatic request or another conversation', () => {
    const storage = new MemoryStorage();
    queuePendingWorkspaceNavigation(storage, event('thread-a', 'event-blocked'), { requiresExplicitAction: true });
    queuePendingWorkspaceNavigation(storage, event('thread-b', 'event-b'), { requiresExplicitAction: true });
    const next = event('thread-a', 'event-next');
    queuePendingWorkspaceNavigation(storage, next);
    clearPendingWorkspaceNavigation(storage, 'thread-a', 'event-blocked');
    const apply = vi.fn(() => true);

    expect(
      consumePendingWorkspaceNavigation({
        storage,
        threadId: 'thread-a',
        canDisplay: true,
        presentationLocked: false,
        apply,
      }),
    ).toBe(true);
    expect(apply).toHaveBeenCalledWith(next);
    expect(getPendingWorkspaceNavigation(storage, 'thread-b')?.eventId).toBe('event-b');
    expect(
      consumePendingWorkspaceNavigation({
        storage,
        threadId: 'thread-b',
        canDisplay: true,
        presentationLocked: false,
        apply,
      }),
    ).toBe(false);
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
