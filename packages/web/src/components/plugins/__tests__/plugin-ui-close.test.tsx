import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginUiEntries } from '../PluginUiEntries';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

describe('plugin panel close recovery', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn() });
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (path: string) =>
      path === '/api/plugin-ui'
        ? Response.json({
            entries: [
              {
                pluginId: 'dev.fixture',
                instanceId: 'fixture',
                commandId: 'open',
                resourcePath: 'panel',
                generation: 'activation',
                label: '问题反馈',
              },
            ],
          })
        : new Response('<p>isolated package UI</p>', { headers: { 'content-type': 'text/html' } }),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const button = (name: string) =>
    Array.from(document.querySelectorAll('button')).find((value) => value.textContent === name);
  const closeButton = () => document.querySelector<HTMLButtonElement>('[aria-label="关闭插件面板"]')!;
  async function openGuardedPanel() {
    await act(async () => root.render(<PluginUiEntries />));
    await act(async () => container.querySelector('button')?.click());
    const frame = document.querySelector('iframe')!;
    const source = frame.contentWindow!;
    let requestId = 0;
    const send = (type: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source,
          data: { channel: 'clowder-plugin-ui/v1', nonce: frame.name, requestId: ++requestId, type, value: true },
        }),
      );
    await act(async () => {
      send('close.guard');
    });
    return { frame, send };
  }
  it.each([false, true])('confirms inside the panel when saving hangs or fails (failed=%s)', async (failed) => {
    const { frame, send } = await openGuardedPanel();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => closeButton().click());
    if (failed)
      await act(async () => {
        send('close.cancel');
      });
    else
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
    await act(async () => button('仍然关闭')?.click());
    const confirmation = document.querySelector('[role="dialog"]');
    expect(confirmation).not.toBeNull();
    expect(document.querySelector('dialog')?.contains(confirmation)).toBe(true);
    expect(document.activeElement).toBe(button('继续等待'));
    await act(async () => button('继续等待')?.click());
    expect(document.querySelector('iframe')).toBe(frame);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button('仍然关闭')?.click());
    await act(async () => button('放弃并关闭')?.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('does not flash save or discard UI for a 30ms save', async () => {
    const { send } = await openGuardedPanel();
    await act(async () => closeButton().click());
    await act(async () => {
      vi.advanceTimersByTime(30);
    });
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(button('仍然关闭')).toBeUndefined();
    await act(async () => {
      send('close');
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('offers a bounded exit at 200ms and accepts a late save with confirmation open', async () => {
    const { send } = await openGuardedPanel();
    await act(async () => closeButton().click());
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(button('仍然关闭')).toBeUndefined();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelector('[role="status"]')?.textContent).toBe('正在保存草稿…');
    await act(async () => button('仍然关闭')?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      send('close');
    });
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('cancels only confirmation on Escape and clears a pending timer on disable/reopen', async () => {
    const { send } = await openGuardedPanel();
    await act(async () => closeButton().click());
    await act(async () => {
      send('close.cancel');
    });
    await act(async () => button('仍然关闭')?.click());
    await act(async () => {
      document
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('iframe')).not.toBeNull();
    await act(async () => closeButton().click());
    apiFetch.mockResolvedValueOnce(Response.json({ entries: [] }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.querySelector('dialog')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => container.querySelector('button')?.click());
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(document.querySelector('iframe')).not.toBeNull();
    expect(button('仍然关闭')).toBeUndefined();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
