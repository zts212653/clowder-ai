import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import {
  type ChatReadingOperations,
  type RegisterChatReadingPort,
  useThreadChatReadingPort,
} from '../useThreadChatReadingPort';

function Surface({
  threadId = 'origin',
  presentation = 'conversation',
  register,
  history,
}: {
  threadId?: string;
  presentation?: 'conversation' | 'composer-only';
  register: RegisterChatReadingPort;
  history: ChatReadingOperations;
}) {
  useThreadChatReadingPort(threadId, presentation, register, history);
  return <main />;
}

describe('surface-owned reading port registration', () => {
  let host: HTMLDivElement;
  let root: Root;
  const operations: ChatReadingOperations = {
    captureReadingRef: vi.fn(() => ({ ref: 'owner-ref', persisted: true })),
    restoreReadingRef: vi.fn(async () => ({ status: 'unavailable' as const })),
    releaseReadingRef: vi.fn(() => true),
    navigateToMessage: vi.fn(async () => ({ status: 'unavailable' as const })),
  };
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    useChatStore.getState().setCurrentThread('origin');
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('exposes the original owner methods without capturing or navigating on mount', () => {
    const release = vi.fn();
    const register = vi.fn<RegisterChatReadingPort>(() => release);
    act(() => root.render(<Surface register={register} history={operations} />));
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toEqual({ threadId: 'origin', ownerId: expect.any(String), ...operations });
    expect(operations.captureReadingRef).not.toHaveBeenCalled();
    expect(operations.navigateToMessage).not.toHaveBeenCalled();
    act(() => root.render(null));
    expect(release).toHaveBeenCalledOnce();
  });

  it('revokes a hidden history surface and registers it again only when conversation returns', () => {
    const release = vi.fn();
    const register = vi.fn<RegisterChatReadingPort>(() => release);
    act(() => root.render(<Surface register={register} history={operations} />));
    act(() => root.render(<Surface register={register} history={operations} presentation="composer-only" />));
    expect(release).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
    act(() => root.render(<Surface register={register} history={operations} />));
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('changes the named owner on a route switch without recapturing the origin', () => {
    const release = vi.fn();
    const register = vi.fn<RegisterChatReadingPort>(() => release);
    act(() => root.render(<Surface register={register} history={operations} />));
    act(() => root.render(<Surface threadId="target" register={register} history={operations} />));
    expect(release).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
    act(() => useChatStore.getState().setCurrentThread('target'));
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[1]?.[0].threadId).toBe('target');
    expect(operations.captureReadingRef).not.toHaveBeenCalled();
  });
});
