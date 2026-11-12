import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatProofApi } from '../../../../test/browser/fixtures/f322-chat-real-page-data.mjs';
import { PluginUiEntries } from '../PluginUiEntries';
import { sandboxedPanelHtml } from '../plugin-panel-bridge';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));
describe('plugin sidebar panel isolation', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn() });
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/plugin-ui')
        return Response.json({
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
        });
      if (path === '/api/plugins/dev.fixture/panel')
        return new Response('<p>isolated package UI</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return Response.json({ ok: true });
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  it('opens only an installed declared entry and never grants same-origin access', async () => {
    await act(async () => root.render(<PluginUiEntries />));
    const entry = container.querySelector('button');
    expect(entry?.getAttribute('aria-label')).toBe('问题反馈');
    await act(async () => entry?.click());
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame!.getAttribute('srcdoc')).toContain("connect-src 'none'");
    expect(frame!.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(frame!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(apiFetch.mock.calls[1][0]).toBe('/api/plugins/dev.fixture/panel');
    expect(apiFetch.mock.calls[1][1].method).toBe('GET');
  });
  it('rejects oversized or malformed panels before executing package bytes', () => {
    expect(() => sandboxedPanelHtml('x'.repeat(2_000_001))).toThrow();
    expect(() => sandboxedPanelHtml({ html: null })).toThrow();
    expect(
      sandboxedPanelHtml('<meta http-equiv="Content-Security-Policy" content="default-src *">').startsWith(
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'',
      ),
    ).toBe(true);
  });
  it.each([
    'success',
    'failure',
  ])('ignores a closed page body that finishes with %s after another page opens', async (outcome) => {
    const entries = ['old', 'current'].map((id) => ({
      pluginId: `dev.${id}`,
      instanceId: id,
      commandId: 'open',
      resourcePath: 'panel',
      generation: id,
      label: id,
    }));
    const body = Promise.withResolvers<string>();
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/plugin-ui') return Response.json({ entries });
      const response = new Response('<p>current page</p>', { headers: { 'content-type': 'text/html' } });
      if (path === '/api/plugins/dev.old/panel') vi.spyOn(response, 'text').mockReturnValue(body.promise);
      return response;
    });
    await act(async () => root.render(<PluginUiEntries />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="old"]')?.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭插件面板"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="current"]')?.click());
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain('current page');
    await act(async () => {
      if (outcome === 'success') body.resolve('<p>old page</p>');
      else body.reject(new Error('old page failed'));
      await body.promise.catch(() => {});
    });
    expect(document.querySelector('iframe')?.getAttribute('title')).toBe('current');
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain('current page');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it('forwards sandbox HTTP requests through the existing declared plugin route and refuses an escaping path', async () => {
    await act(async () => root.render(<PluginUiEntries />));
    await act(async () => container.querySelector('button')?.click());
    const frame = document.querySelector('iframe')!;
    const source = frame.contentWindow!;
    const post = vi.spyOn(source, 'postMessage');
    const send = (requestId: number, path: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source,
          data: {
            channel: 'clowder-plugin-ui/v1',
            nonce: frame.name,
            requestId,
            type: 'http',
            request: { method: 'POST', path, body: { op: 'list' } },
          },
        }),
      );
    await act(async () => {
      send(1, 'feedback');
    });
    expect(apiFetch.mock.calls[2]?.[0]).toBe('/api/plugins/dev.fixture/feedback');
    expect(JSON.parse(apiFetch.mock.calls[2]?.[1].body)).toEqual({ op: 'list' });
    expect(apiFetch.mock.calls[2]?.[1].headers['x-clowder-plugin-ui-generation']).toBe('activation');
    const count = apiFetch.mock.calls.length;
    await act(async () => {
      send(2, '../../other-plugin/write');
    });
    expect(apiFetch.mock.calls.length).toBe(count);
    expect(post.mock.calls.at(-1)?.[0]).toHaveProperty('error');
  });
  it.each(['button', 'escape'])('waits for a registered panel to save before closing via %s', async (method) => {
    await act(async () => root.render(<PluginUiEntries />));
    await act(async () => container.querySelector('button')?.click());
    const frame = document.querySelector('iframe')!;
    const source = frame.contentWindow!;
    const post = vi.spyOn(source, 'postMessage');
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
    let cancellation: Event | undefined;
    await act(async () => {
      if (method === 'button') document.querySelector<HTMLButtonElement>('[aria-label="关闭插件面板"]')?.click();
      else {
        cancellation = new Event('cancel', { cancelable: true });
        document.querySelector('dialog')?.dispatchEvent(cancellation);
      }
    });
    expect(document.querySelector('iframe')).toBe(frame);
    if (cancellation) expect(cancellation.defaultPrevented).toBe(true);
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'before-close', nonce: frame.name });
    await act(async () => {
      send('close.cancel');
    });
    expect(document.querySelector<HTMLButtonElement>('[aria-label="关闭插件面板"]')?.disabled).toBe(false);
    await act(async () => {
      send('close');
    });
    expect(document.querySelector('iframe')).toBeNull();
  });
  it.each([false, true])('allows confirmed close when a panel is hung or failed (cancelled=%s)', async (cancelled) => {
    await act(async () => root.render(<PluginUiEntries />));
    await act(async () => container.querySelector('button')?.click());
    const frame = document.querySelector('iframe')!;
    const source = frame.contentWindow!;
    const send = (type:string,requestId:number) => window.dispatchEvent(new MessageEvent('message', {
      source,data:{channel:'clowder-plugin-ui/v1',nonce:frame.name,type,requestId,value:true},
    }));
    await act(async () => {send('close.guard',1);});
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭插件面板"]')?.click());
    if(cancelled)await act(async () => {send('close.cancel',2);});
    const force = Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='仍然关闭');
    expect(force).toBeDefined();
    const confirm=vi.spyOn(window,'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => force?.click());
    expect(document.querySelector('iframe')).toBe(frame);
    await act(async () => force?.click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('returns an explicit error for oversized sandbox messages', async () => {
    await act(async () => root.render(<PluginUiEntries />));
    await act(async () => container.querySelector('button')?.click());
    const frame = document.querySelector('iframe')!;
    const source = frame.contentWindow!;
    const post=vi.spyOn(source,'postMessage');
    await act(async () => {window.dispatchEvent(new MessageEvent('message', {
      source,data:{channel:'clowder-plugin-ui/v1',nonce:frame.name,requestId:1,type:'clipboard.text',value:'x'.repeat(24_000_000)},
    }));});
    expect(post.mock.calls.at(-1)?.[0]).toHaveProperty('error');
  });
  it('production-page HTTP fixture represents an empty installed UI registry without admitting mutations', () => {
    const fixture = createChatProofApi(Date.now(), false, true);
    const url = new URL('http://localhost/api/plugin-ui');
    const response = fixture.respond({ method: () => 'GET' }, url);
    expect(response?.status).toBe(200);
    expect(JSON.parse(response!.body)).toEqual({ entries: [] });
    expect(fixture.respond({ method: () => 'POST', postDataJSON: () => ({}) }, url)).toBeNull();
  });
});
