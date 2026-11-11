import { describe, expect, it, vi } from 'vitest';
import { deliverPreviewAutoOpenEvent, type PreviewAutoOpenEvent } from '../preview-auto-open-delivery';

const event = (fields: Partial<PreviewAutoOpenEvent> = {}): PreviewAutoOpenEvent => ({
  port: 5173,
  path: '/dash',
  eventId: 'event',
  threadId: 'thread',
  ...fields,
});
const input = (data = event()) => ({
  data,
  activeThreadId: 'thread',
  clientVisible: true,
  presentationLocked: false,
  sessionWorktreeId: null as string | null,
  apply: vi.fn(() => true),
});

describe('preview command delivery', () => {
  it('opens the current visible thread and returns the existing applied receipt', () => {
    const port = input();
    expect(deliverPreviewAutoOpenEvent(port)).toEqual({ status: 'applied', eventId: 'event' });
    expect(port.apply).toHaveBeenCalledExactlyOnceWith(port.data);
  });
  it('opens an unscoped event in the current thread', () => {
    const port = input(event({ threadId: undefined }));
    expect(deliverPreviewAutoOpenEvent(port).status).toBe('applied');
    expect(port.apply).toHaveBeenCalledOnce();
  });
  it.each([
    { threadId: 'other' },
    { threadId: 'other', worktreeId: 'other-worktree' },
    { threadId: 'other', visiblePageAdmission: { expectedClientRevision: 'a'.repeat(40), requiredDom: [] } },
  ])('answers not visible for another thread (%j)', (fields) => {
    const port = input(event(fields));
    expect(deliverPreviewAutoOpenEvent(port)).toEqual({
      status: 'skipped',
      eventId: 'event',
      reason: 'client_inactive',
    });
    expect(port.apply).not.toHaveBeenCalled();
  });
  it.each([true, false])('answers not visible for a hidden document, admission %s', (proof) => {
    const port = input(
      event(proof ? { visiblePageAdmission: { expectedClientRevision: 'a'.repeat(40), requiredDom: [] } } : {}),
    );
    port.clientVisible = false;
    expect(deliverPreviewAutoOpenEvent(port)).toEqual({
      status: 'skipped',
      eventId: 'event',
      reason: 'client_inactive',
    });
    expect(port.apply).not.toHaveBeenCalled();
  });
  it('keeps the current-thread presentation lock receipt', () => {
    const port = input();
    port.presentationLocked = true;
    expect(deliverPreviewAutoOpenEvent(port)).toEqual({
      status: 'blocked',
      eventId: 'event',
      reason: 'presentation_lock',
    });
    expect(port.apply).not.toHaveBeenCalled();
  });
  it('keeps the current worktree scope check', () => {
    const port = input(event({ worktreeId: 'other' }));
    port.sessionWorktreeId = 'mine';
    expect(deliverPreviewAutoOpenEvent(port)).toEqual({
      status: 'skipped',
      eventId: 'event',
      reason: 'worktree_mismatch',
    });
    expect(port.apply).not.toHaveBeenCalled();
  });
  it('answers not visible if the console has not accepted the open command', () => {
    const port = input();
    port.apply.mockReturnValue(false);
    expect(deliverPreviewAutoOpenEvent(port)).toEqual({
      status: 'skipped',
      eventId: 'event',
      reason: 'client_inactive',
    });
  });
});
