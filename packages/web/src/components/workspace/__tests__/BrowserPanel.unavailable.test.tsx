import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../useHmrStatus', () => ({ useHmrStatus: () => 'idle' }));
vi.mock('../usePreviewBridge', () => ({
  usePreviewBridge: () => ({
    consoleEntries: [],
    consoleOpen: false,
    setConsoleOpen: vi.fn(),
    isCapturing: false,
    screenshotUrl: null,
    handleScreenshot: vi.fn(),
    clearConsole: vi.fn(),
  }),
}));
vi.mock('../BrowserToolbar', () => ({
  BrowserToolbar: () => React.createElement('div', { 'data-testid': 'browser-toolbar' }),
}));

import { useChatStore } from '@/stores/chatStore';
import { BrowserPanel } from '../BrowserPanel';

/**
 * F120 × F284: a restored preview whose target dev server died must show an
 * explicit stopped/unavailable state with a recovery action — never a shell
 * iframe rendering the gateway's 502 JSON.
 */
describe('BrowserPanel unavailable target', () => {
  let container: HTMLDivElement;
  let root: Root;
  let reachable: boolean;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    reachable = false;
    useChatStore.setState({ rightPanelOpen: false, rightPanelMode: 'status', workspaceSurface: 'home' });
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/preview/status') {
        return { json: async () => ({ available: true, gatewayPort: 4111 }) };
      }
      if (typeof url === 'string' && url.startsWith('/api/preview/target-health')) {
        return { json: async () => ({ port: 5173, reachable }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (container.isConnected) {
      act(() => root.unmount());
      container.remove();
    }
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows a stopped state with a retry action instead of the iframe when the target is unreachable', async () => {
    await act(async () => {
      root.render(<BrowserPanel initialPort={5173} />);
    });

    // Health probe fired for the restored target
    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/preview/target-health'));

    const unavailable = container.querySelector('[data-testid="preview-unavailable"]');
    expect(unavailable).not.toBeNull();
    expect(unavailable?.textContent).toContain('5173');
    // No blank/error shell iframe while stopped
    expect(container.querySelector('iframe')).toBeNull();

    // Recovery: dev server comes back, user hits retry → iframe loads
    reachable = true;
    const retry = Array.from(container.querySelectorAll('button')).find((b) => /重试|retry/i.test(b.textContent ?? ''));
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="preview-unavailable"]')).toBeNull();
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('loads the iframe directly when the target is reachable', async () => {
    reachable = true;
    await act(async () => {
      root.render(<BrowserPanel initialPort={5173} />);
    });

    expect(container.querySelector('[data-testid="preview-unavailable"]')).toBeNull();
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe('http://preview-5173.localhost:4111/');
  });

  it('re-probes when the browser surface becomes visible again (fold → target dies → reopen)', async () => {
    // Start visible and reachable — iframe loads
    reachable = true;
    useChatStore.setState({ rightPanelOpen: true, rightPanelMode: 'workspace', workspaceSurface: 'browser' });
    await act(async () => {
      root.render(<BrowserPanel initialPort={5173} />);
    });
    expect(container.querySelector('iframe')).not.toBeNull();

    // Fold the panel (F284 keeps BrowserPanel mounted), then the target dies
    reachable = false;
    await act(async () => {
      useChatStore.setState({ rightPanelOpen: false });
    });
    const probesBefore = mocks.apiFetch.mock.calls.filter(([url]) =>
      String(url).startsWith('/api/preview/target-health'),
    ).length;

    // Reopen — must re-probe even though targetPort never changed
    await act(async () => {
      useChatStore.setState({ rightPanelOpen: true });
    });
    const probesAfter = mocks.apiFetch.mock.calls.filter(([url]) =>
      String(url).startsWith('/api/preview/target-health'),
    ).length;
    expect(probesAfter).toBeGreaterThan(probesBefore);

    // Dead target now surfaces the stopped state instead of the stale iframe
    expect(container.querySelector('[data-testid="preview-unavailable"]')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });
});
