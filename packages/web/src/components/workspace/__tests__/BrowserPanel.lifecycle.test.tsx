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

import { BrowserPanel } from '../BrowserPanel';

describe('F284 BrowserPanel preview lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
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
});
