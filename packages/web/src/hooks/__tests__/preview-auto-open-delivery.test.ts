import { describe, expect, it, vi } from 'vitest';
import { deliverPreviewAutoOpenEvent, type PreviewAutoOpenEvent } from '../preview-auto-open-delivery';

function makeEvent(overrides: Partial<PreviewAutoOpenEvent> = {}): PreviewAutoOpenEvent {
  return { port: 5173, path: '/dash', eventId: 'evt-1', ...overrides };
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    data: makeEvent(),
    activeThreadId: 'thread-a',
    clientVisible: true,
    presentationLocked: false,
    sessionWorktreeId: null,
    // Default: target thread has no saved scope (fail-closed for scoped events,
    // open for unscoped/global events).
    resolveTargetWorktreeId: vi.fn(() => null),
    apply: vi.fn(),
    queueForThread: vi.fn(),
    ...overrides,
  };
}

/**
 * F120 delivery contract: admission ≠ visible. The socket handler must reply
 * an explicit receipt — applied / queued / blocked / skipped — instead of
 * silently dropping events it cannot display.
 */
describe('deliverPreviewAutoOpenEvent', () => {
  it('applies to the active thread and acks applied', () => {
    const input = makeInput({ data: makeEvent({ threadId: 'thread-a' }) });
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'applied', eventId: 'evt-1' });
    expect(input.apply).toHaveBeenCalledWith(makeEvent({ threadId: 'thread-a' }));
    expect(input.queueForThread).not.toHaveBeenCalled();
  });

  it('applies global events without threadId', () => {
    const input = makeInput();
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'applied', eventId: 'evt-1' });
    expect(input.apply).toHaveBeenCalled();
  });

  it('queues into the target thread when it is inactive and acks queued/thread_inactive', () => {
    const input = makeInput({ data: makeEvent({ threadId: 'thread-b' }) });
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'queued', eventId: 'evt-1', reason: 'thread_inactive' });
    expect(input.apply).not.toHaveBeenCalled();
    expect(input.queueForThread).toHaveBeenCalledWith('thread-b', { port: 5173, path: '/dash' });
  });

  it('does not let a hidden Hub tab claim custody of an inactive-thread preview', () => {
    const input = makeInput({
      data: makeEvent({ threadId: 'thread-b' }),
      clientVisible: false,
    });
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'skipped', eventId: 'evt-1', reason: 'client_inactive' });
    expect(input.apply).not.toHaveBeenCalled();
    expect(input.queueForThread).not.toHaveBeenCalled();
  });

  it('inactive target is judged by its OWN worktree: foreground B/wt-b, target A saved wt-a, event A/wt-a → queued', () => {
    const input = makeInput({
      data: makeEvent({ threadId: 'thread-b', worktreeId: 'wt-a' }),
      activeThreadId: 'thread-c',
      sessionWorktreeId: 'wt-b',
      resolveTargetWorktreeId: vi.fn(() => 'wt-a'),
    });
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'queued', eventId: 'evt-1', reason: 'thread_inactive' });
    expect(input.queueForThread).toHaveBeenCalledWith('thread-b', { port: 5173, path: '/dash' });
    expect(input.apply).not.toHaveBeenCalled();
  });

  it('inactive target saved wt-a + event wt-other → skipped with zero writes', () => {
    const input = makeInput({
      data: makeEvent({ threadId: 'thread-b', worktreeId: 'wt-other' }),
      sessionWorktreeId: null,
      resolveTargetWorktreeId: vi.fn(() => 'wt-a'),
    });
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'skipped', eventId: 'evt-1', reason: 'worktree_mismatch' });
    expect(input.queueForThread).not.toHaveBeenCalled();
    expect(input.apply).not.toHaveBeenCalled();
  });

  it('inactive target with unprovable scope → fail closed (skipped, zero writes)', () => {
    const input = makeInput({
      data: makeEvent({ threadId: 'thread-b', worktreeId: 'wt-a' }),
      sessionWorktreeId: null,
      resolveTargetWorktreeId: vi.fn(() => undefined),
    });
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'skipped', eventId: 'evt-1', reason: 'worktree_mismatch' });
    expect(input.queueForThread).not.toHaveBeenCalled();
    expect(input.apply).not.toHaveBeenCalled();
  });

  it('defaults queued path to / when omitted', () => {
    const input = makeInput({ data: { port: 3000, threadId: 'thread-b', eventId: 'evt-2' } });
    deliverPreviewAutoOpenEvent(input);
    expect(input.queueForThread).toHaveBeenCalledWith('thread-b', { port: 3000, path: '/' });
  });

  it('acks blocked/presentation_lock without applying or queueing', () => {
    const input = makeInput({ data: makeEvent({ threadId: 'thread-a' }), presentationLocked: true });
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'blocked', eventId: 'evt-1', reason: 'presentation_lock' });
    expect(input.apply).not.toHaveBeenCalled();
    expect(input.queueForThread).not.toHaveBeenCalled();
  });

  it('acks skipped/worktree_mismatch on the apply path without side effects', () => {
    const input = makeInput({
      data: makeEvent({ threadId: 'thread-a', worktreeId: 'wt-other' }),
      sessionWorktreeId: 'wt-mine',
    });
    const receipt = deliverPreviewAutoOpenEvent(input);
    expect(receipt).toEqual({ status: 'skipped', eventId: 'evt-1', reason: 'worktree_mismatch' });
    expect(input.apply).not.toHaveBeenCalled();
    expect(input.queueForThread).not.toHaveBeenCalled();
  });

  it('tolerates a missing eventId', () => {
    const receipt = deliverPreviewAutoOpenEvent(makeInput({ data: { port: 5173 } }));
    expect(receipt.status).toBe('applied');
    expect(receipt.eventId).toBe('');
  });
});
