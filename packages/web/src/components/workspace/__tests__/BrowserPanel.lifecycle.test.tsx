import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  hmrEnabled: [] as boolean[],
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../useHmrStatus', () => ({
  useHmrStatus: (_gatewayPort: number, _targetPort: number, enabled = true) => {
    mocks.hmrEnabled.push(enabled);
    return 'idle';
  },
}));
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

import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { BrowserPanel } from '../BrowserPanel';

describe('F284 BrowserPanel preview lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.hmrEnabled = [];
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/preview/status') {
        return { json: async () => ({ available: true, gatewayPort: 4111 }) };
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

  it('does not terminate the backend preview when the shell unmounts', async () => {
    await act(async () => {
      root.render(<BrowserPanel initialPort={5173} />);
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();

    expect(mocks.apiFetch).not.toHaveBeenCalledWith('/api/preview/close', expect.anything());
  });

  it('terminates the backend preview only when its tab is explicitly closed', async () => {
    await act(async () => {
      root.render(<BrowserPanel initialPort={5173} />);
    });

    const closeButton = Array.from(container.querySelectorAll('[role="button"]')).find(
      (node) => node.textContent === '×',
    );
    expect(closeButton).toBeDefined();

    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/preview/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 5173 }),
    });
  });

  it('keeps the preview instance while hidden, pauses HMR detail work, and re-probes once on return', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/preview/status') {
        return { json: async () => ({ available: true, gatewayPort: 4111 }) };
      }
      if (url.startsWith('/api/preview/target-health')) {
        return { ok: true, json: async () => ({ reachable: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    const render = async (visible: boolean) => {
      await act(async () => {
        root.render(
          <WorkspaceSurfaceVisibilityProvider visible={visible}>
            <BrowserPanel initialPort={5173} initialPath="/owner-a" />
          </WorkspaceSurfaceVisibilityProvider>,
        );
        await Promise.resolve();
      });
    };
    const requestCount = (prefix: string) =>
      mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith(prefix)).length;

    await render(false);
    expect(requestCount('/api/preview/status')).toBe(0);
    expect(requestCount('/api/preview/target-health')).toBe(0);
    expect(mocks.hmrEnabled.at(-1)).toBe(false);

    await render(true);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(requestCount('/api/preview/status')).toBe(1);
    const healthBeforeHide = requestCount('/api/preview/target-health');
    expect(healthBeforeHide).toBe(1);
    expect(mocks.hmrEnabled.at(-1)).toBe(true);

    await render(false);
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(requestCount('/api/preview/status')).toBe(1);
    expect(requestCount('/api/preview/target-health')).toBe(healthBeforeHide);
    expect(mocks.hmrEnabled.at(-1)).toBe(false);

    await render(true);
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(requestCount('/api/preview/status')).toBe(1);
    expect(requestCount('/api/preview/target-health')).toBe(healthBeforeHide + 1);
    expect(mocks.hmrEnabled.at(-1)).toBe(true);
  });
});
