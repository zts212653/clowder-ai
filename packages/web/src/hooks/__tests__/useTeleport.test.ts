import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPendingTeleportForTest, resolvePendingTeleport } from '@/utils/teleport';
import { handleTeleportEvent } from '../useTeleport';

describe('handleTeleportEvent (F227)', () => {
  beforeEach(() => __resetPendingTeleportForTest());

  it('same thread → scrolls now, no navigation', () => {
    const pushThreadRoute = vi.fn();
    const scrollToMessage = vi.fn();
    const result = handleTeleportEvent({ threadId: 'thread_a', messageId: 'm1' }, 'thread_a', {
      pushThreadRoute,
      scrollToMessage,
    });
    expect(result).toBe('scrolled');
    expect(scrollToMessage).toHaveBeenCalledWith('m1');
    expect(pushThreadRoute).not.toHaveBeenCalled();
  });

  it('different thread → pushes route + records a pending teleport', () => {
    const pushThreadRoute = vi.fn();
    const scrollToMessage = vi.fn();
    const result = handleTeleportEvent({ threadId: 'thread_b', messageId: 'm2' }, 'thread_a', {
      pushThreadRoute,
      scrollToMessage,
    });
    expect(result).toBe('navigated');
    expect(pushThreadRoute).toHaveBeenCalledWith('thread_b');
    expect(scrollToMessage).not.toHaveBeenCalled();
    // the pending teleport is recorded so useChatHistory resolves it after render
    expect(resolvePendingTeleport('thread_b', ['m2'], { authoritative: true })).toBe('m2');
  });

  it('cold load (null currentThreadId) → navigates', () => {
    const pushThreadRoute = vi.fn();
    const scrollToMessage = vi.fn();
    const result = handleTeleportEvent({ threadId: 'thread_b', messageId: 'm2' }, null, {
      pushThreadRoute,
      scrollToMessage,
    });
    expect(result).toBe('navigated');
    expect(pushThreadRoute).toHaveBeenCalledWith('thread_b');
  });

  it('ignores events missing threadId or messageId', () => {
    const pushThreadRoute = vi.fn();
    const scrollToMessage = vi.fn();
    expect(
      handleTeleportEvent({ threadId: 'thread_a', messageId: '' }, 'thread_a', { pushThreadRoute, scrollToMessage }),
    ).toBe('ignored');
    expect(
      handleTeleportEvent({ threadId: '', messageId: 'm1' }, 'thread_a', { pushThreadRoute, scrollToMessage }),
    ).toBe('ignored');
    expect(scrollToMessage).not.toHaveBeenCalled();
    expect(pushThreadRoute).not.toHaveBeenCalled();
  });
});
