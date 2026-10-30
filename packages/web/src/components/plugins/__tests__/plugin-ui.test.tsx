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
    apiFetch.mockImplementation(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path === '/api/plugin-ui'
              ? { entries: [{ instanceId: 'fixture', commandId: 'open', generation: 'activation', label: '问题反馈' }] }
              : { result: { kind: 'plugin-panel', version: 1, html: '<p>isolated package UI</p>' } },
          ),
        ),
    );
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
    expect(apiFetch.mock.calls[1][0]).toBe('/api/plugin-ui/fixture/open');
  });
  it('rejects oversized or malformed panels before executing package bytes', () => {
    expect(() => sandboxedPanelHtml({ html: 'x'.repeat(2_000_001) })).toThrow();
    expect(() => sandboxedPanelHtml({ html: null })).toThrow();
    expect(
      sandboxedPanelHtml({
        kind: 'plugin-panel',
        version: 1,
        html: '<meta http-equiv="Content-Security-Policy" content="default-src *">',
      }).startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\''),
    ).toBe(true);
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
