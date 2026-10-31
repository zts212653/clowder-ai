import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { captureChatReadingRef, readChatReadingRef } from '@/utils/chat-scroll-memory';
import { resolvePin } from '../../settings/settings-ia';
import { type ChatReadingPort, useThreadChatReadingPort } from '../../thread-chat/useThreadChatReadingPort';
import { SettingsReadingBridge } from '../settings-reading-bridge';
import { readSettingsReadingSession } from '../settings-reading-session';
import { useOpenDestination } from '../use-open-destination';
import {
  SettingsSourceReturnProvider,
  useSettingsReadingPort,
  useSettingsSourceReturn,
} from '../useSettingsSourceReturn';

const nav = vi.hoisted(() => ({ pathname: '/thread/origin', push: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: nav.push }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

function readingPort(ownerId: string): ChatReadingPort {
  return {
    threadId: 'origin',
    ownerId,
    captureReadingRef: vi.fn(() =>
      captureChatReadingRef({
        threadId: 'origin',
        position: { top: 320, anchor: 'offset', messageAnchor: { messageId: 'm', viewportOffsetPx: 42 } },
      }),
    ),
    restoreReadingRef: vi.fn(async () => ({
      status: 'settled' as const,
      exact: true,
      position: { top: 320, anchor: 'offset' as const },
    })),
    releaseReadingRef: vi.fn(() => true),
    navigateToMessage: vi.fn(async () => ({ status: 'unavailable' as const })),
  };
}
function OriginalReader({ reader, label }: { reader: ChatReadingPort; label: string | null }) {
  const register = useSettingsReadingPort(label);
  const registerOriginal = useCallback((port: ChatReadingPort) => register(port), [register]);
  useThreadChatReadingPort(reader.threadId, 'conversation', registerOriginal, reader);
  return null;
}
function PinEntry() {
  const { openPin } = useOpenDestination();
  const pin = resolvePin('notify');
  return (
    <button
      type="button"
      data-testid="pin"
      onClick={() => {
        if (pin) openPin(pin);
      }}
    >
      Settings pin
    </button>
  );
}
function Consumer() {
  const source = useSettingsSourceReturn();
  return source ? (
    <button type="button" data-testid="return" onClick={source.onReturn}>
      {source.label}
    </button>
  ) : null;
}

describe('the real Settings entry and original reader survive the route boundary', () => {
  let root: Root;
  let host: HTMLDivElement;
  const old = readingPort('old');
  function render(
    pathname: string,
    reader: ChatReadingPort | null = null,
    label: string | null = 'Real origin',
    enabled = true,
  ) {
    nav.pathname = pathname.split('?')[0];
    window.history.replaceState(null, '', pathname);
    act(() =>
      root.render(
        <SettingsSourceReturnProvider pathname={nav.pathname} enabled={enabled}>
          {reader && <OriginalReader key={reader.ownerId} reader={reader} label={label} />}
          <PinEntry />
          <Consumer />
        </SettingsSourceReturnProvider>,
      ),
    );
  }
  const click = async (testId: string) =>
    act(async () => {
      host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
    });
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    useToastStore.setState({ toasts: [] });
    useChatStore.getState().setCurrentThread('origin');
    vi.clearAllMocks();
    vi.mocked(apiFetch).mockResolvedValue(
      Response.json({ status: 'available', updated: false, target: { threadId: 'origin' } }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('captures through the actual pinned Settings entry and restores through the remounted original port', async () => {
    render('/thread/origin', old);
    await click('pin');
    const source = readSettingsReadingSession();
    expect(source?.label).toBe('Real origin');
    expect(nav.push).toHaveBeenCalledWith('/settings?s=notify&standalone=1&from=origin');
    render('/settings');
    expect(host.querySelector('[data-testid="return"]')?.textContent).toBe('Real origin');
    await click('return');
    expect(nav.push).toHaveBeenLastCalledWith('/thread/origin');
    expect(old.restoreReadingRef).not.toHaveBeenCalled();
    const mounted = readingPort('new');
    render('/thread/origin', mounted);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mounted.restoreReadingRef).toHaveBeenCalledWith(source?.readingRef, expect.any(AbortSignal), {
      refresh: true,
    });
    expect(readSettingsReadingSession()).toBeNull();
  });

  it('direct Settings with a from parameter has no source, and an unknown title cannot manufacture one', async () => {
    render('/settings?from=origin');
    expect(host.querySelector('[data-testid="return"]')).toBeNull();
    render('/thread/origin', old, null);
    await click('pin');
    render('/settings');
    expect(host.querySelector('[data-testid="return"]')).toBeNull();
    expect(old.captureReadingRef).not.toHaveBeenCalled();
  });

  it('keeps the same reading owner restoring while its canonical title hydrates', async () => {
    render('/thread/origin', old);
    await click('pin');
    const source = readSettingsReadingSession();
    expect(source).not.toBeNull();
    render('/settings');
    await click('return');
    const mounted = readingPort('same-mounted-owner');
    let finish!: (receipt: Awaited<ReturnType<ChatReadingPort['restoreReadingRef']>>) => void;
    const restoration = new Promise<Awaited<ReturnType<ChatReadingPort['restoreReadingRef']>>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(mounted.restoreReadingRef).mockReturnValueOnce(restoration);
    render('/thread/origin', mounted, null);
    const signal = vi.mocked(mounted.restoreReadingRef).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    render('/thread/origin', mounted, 'Hydrated canonical title');
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      finish({ status: 'settled', exact: true, position: { top: 320, anchor: 'offset' } });
      await restoration;
    });
    expect(mounted.restoreReadingRef).toHaveBeenCalledTimes(1);
    expect(readSettingsReadingSession()).toBeNull();
    expect(useToastStore.getState().toasts.some((toast) => toast.message?.includes('返回已中断'))).toBe(false);
    await click('pin');
    expect(readSettingsReadingSession()?.label).toBe('Hydrated canonical title');
  });

  it('shows an honest existing toast when fresh admission rejects return, preserving its source', async () => {
    render('/thread/origin', old);
    await click('pin');
    render('/settings');
    const source = readSettingsReadingSession();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await click('return');
    expect(readSettingsReadingSession()?.id).toBe(source?.id);
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('未能恢复');
    expect(old.restoreReadingRef).not.toHaveBeenCalled();
  });

  it('does not replay a dismissed error when the same provider remounts its notice consumer', async () => {
    render('/thread/origin', old);
    await click('pin');
    render('/settings');
    const captureNotice = useToastStore.getState().toasts[0];
    expect(captureNotice?.message).toContain('返回位置未能保存');
    useToastStore.getState().removeToast(captureNotice.id);
    const source = readSettingsReadingSession();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await click('return');
    const toast = useToastStore.getState().toasts[0];
    expect(toast?.message).toContain('未能恢复');
    const requests = vi.mocked(apiFetch).mock.calls.length;
    useToastStore.getState().removeToast(toast.id);
    const unrelated = useToastStore
      .getState()
      .addToast({ type: 'info', title: 'Other', message: 'Keep me', duration: 0 });
    for (let count = 0; count < 2; count++) {
      render('/settings', null, 'Real origin', false);
      render('/settings');
      expect(useToastStore.getState().toasts.map((item) => item.id)).toEqual([unrelated]);
    }
    expect(vi.mocked(apiFetch).mock.calls).toHaveLength(requests);
    expect(readSettingsReadingSession()?.id).toBe(source?.id);
    expect(host.querySelector('[data-testid="return"]')).not.toBeNull();
  });

  it('reports a new rejected retry even when its source and error kind are unchanged', async () => {
    render('/thread/origin', old);
    await click('pin');
    render('/settings');
    const captureNotice = useToastStore.getState().toasts[0];
    expect(captureNotice?.message).toContain('返回位置未能保存');
    useToastStore.getState().removeToast(captureNotice.id);
    const source = readSettingsReadingSession();
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 403 }));
    await click('return');
    const first = useToastStore.getState().toasts[0];
    expect(first?.type).toBe('error');
    useToastStore.getState().removeToast(first.id);
    await click('return');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).not.toBe(first.id);
    expect(toasts[0].message).toContain('未能恢复');
    expect(readSettingsReadingSession()?.id).toBe(source?.id);
    expect(old.restoreReadingRef).not.toHaveBeenCalled();
  });

  it('consumes only the exact notice snapshot and leaves a newer same-kind error intact', () => {
    const bridge = new SettingsReadingBridge(nav.push);
    bridge.setRoute('/thread/origin', true);
    const reader = readingPort('failed-capture');
    vi.mocked(reader.captureReadingRef).mockReturnValue(null);
    bridge.registerReadingPort(reader, () => 'Real origin');
    bridge.captureBeforeSettings();
    const first = bridge.getSnapshot();
    expect(bridge.consumeNotice(first)).toBe('unavailable');
    expect(bridge.consumeNotice(first)).toBeNull();
    bridge.captureBeforeSettings();
    const second = bridge.getSnapshot();
    expect(second.notice).toBe('unavailable');
    expect(bridge.consumeNotice(first)).toBeNull();
    expect(bridge.getSnapshot()).toBe(second);
    expect(bridge.consumeNotice(second)).toBe('unavailable');
    expect(bridge.getSnapshot().notice).toBeNull();
    bridge.dispose();
  });

  it('reports an actual reader interruption once and fences its late exact receipt', async () => {
    render('/thread/origin', old);
    await click('pin');
    render('/settings');
    const captureNotice = useToastStore.getState().toasts[0];
    expect(captureNotice?.message).toContain('返回位置未能保存');
    useToastStore.getState().removeToast(captureNotice.id);
    const source = readSettingsReadingSession();
    await click('return');
    const mounted = readingPort('pending-owner');
    let finish!: (receipt: Awaited<ReturnType<ChatReadingPort['restoreReadingRef']>>) => void;
    const restoration = new Promise<Awaited<ReturnType<ChatReadingPort['restoreReadingRef']>>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(mounted.restoreReadingRef).mockReturnValueOnce(restoration);
    render('/thread/origin', mounted);
    const signal = vi.mocked(mounted.restoreReadingRef).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    render('/thread/origin');
    expect(signal?.aborted).toBe(true);
    const toast = useToastStore.getState().toasts[0];
    expect(toast?.message).toContain('返回已中断');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    useToastStore.getState().removeToast(toast.id);
    render('/thread/origin', null, 'Real origin', false);
    render('/thread/origin');
    expect(useToastStore.getState().toasts).toHaveLength(0);
    await act(async () => {
      finish({ status: 'settled', exact: true, position: { top: 320, anchor: 'offset' } });
      await restoration;
    });
    expect(readSettingsReadingSession()?.id).toBe(source?.id);
    expect(readChatReadingRef(source?.readingRef ?? '')).toBeDefined();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    render('/settings');
    expect(host.querySelector('[data-testid="return"]')).not.toBeNull();
  });
});
