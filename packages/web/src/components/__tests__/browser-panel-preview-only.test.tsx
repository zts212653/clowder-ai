import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  useHmrStatus: vi.fn(),
  usePreviewBridge: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock('@/components/workspace/BrowserToolbar', () => ({
  BrowserToolbar: ({
    urlInput,
    onUrlChange,
    onNavigate,
  }: {
    urlInput: string;
    onUrlChange: (value: string) => void;
    onNavigate: () => void;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'browser-toolbar' },
      React.createElement('input', {
        'data-testid': 'browser-toolbar-input',
        value: urlInput,
        onChange: (e: Event) => onUrlChange((e.target as HTMLInputElement).value),
      }),
      React.createElement('button', { type: 'button', 'data-testid': 'browser-toolbar-go', onClick: onNavigate }, 'Go'),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'browser-toolbar-set-url',
          onClick: () => onUrlChange('localhost:4173/deep'),
        },
        'Set URL',
      ),
    ),
}));

vi.mock('@/components/workspace/BrowserTabBar', () => ({
  BrowserTabBar: () => React.createElement('div', { 'data-testid': 'browser-tab-bar' }),
}));

vi.mock('@/components/workspace/ConsolePanel', () => ({
  ConsolePanel: () => React.createElement('div', { 'data-testid': 'console-panel' }),
}));

vi.mock('@/components/workspace/useHmrStatus', () => ({
  useHmrStatus: (...args: unknown[]) => mocks.useHmrStatus(...args),
}));

vi.mock('@/components/workspace/usePreviewBridge', () => ({
  usePreviewBridge: (...args: unknown[]) => mocks.usePreviewBridge(...args),
}));

function setupMocks() {
  mocks.apiFetch.mockImplementation((url: string) => {
    if (url === '/api/preview/status') {
      return Promise.resolve({
        json: async () => ({ available: true, gatewayPort: 4100 }),
      });
    }
    return Promise.resolve({
      json: async () => ({ allowed: true }),
      ok: true,
    });
  });
  mocks.useHmrStatus.mockReturnValue('connected');
  mocks.usePreviewBridge.mockReturnValue({
    consoleEntries: [{ level: 'error', args: ['boom'], timestamp: 1 }],
    consoleOpen: true,
    setConsoleOpen: vi.fn(),
    isCapturing: false,
    screenshotUrl: '/shot.png',
    handleScreenshot: vi.fn(),
    clearConsole: vi.fn(),
  });
}

describe('BrowserPanel previewOnly chrome', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    setupMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders browser chrome in normal mode', async () => {
    const { BrowserPanel } = await import('@/components/workspace/BrowserPanel');

    await act(async () => {
      root.render(React.createElement(BrowserPanel, { initialPort: 5173, initialPath: '/' }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="browser-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser-tab-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="console-panel"]')).not.toBeNull();
    expect(container.textContent).toContain('HMR connected');
    expect(container.textContent).toContain('Screenshot saved');
    expect(container.textContent).toContain('localhost:5173 via gateway:4100');
  });

  it('hides browser chrome in previewOnly mode while keeping the preview iframe', async () => {
    const { BrowserPanel } = await import('@/components/workspace/BrowserPanel');

    await act(async () => {
      root.render(React.createElement(BrowserPanel, { initialPort: 5173, initialPath: '/', previewOnly: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="browser-toolbar"]')).toBeNull();
    expect(container.querySelector('[data-testid="browser-tab-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="console-panel"]')).toBeNull();
    expect(container.textContent).not.toContain('HMR connected');
    expect(container.textContent).not.toContain('Screenshot saved');
    expect(container.textContent).not.toContain('localhost:5173 via gateway:4100');
    expect(container.querySelector('iframe[title="Preview"]')).not.toBeNull();
  });

  it('syncs latest target to parent via onNavigate callback', async () => {
    const { BrowserPanel } = await import('@/components/workspace/BrowserPanel');
    const onNavigate = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(BrowserPanel, {
          initialPort: 5173,
          initialPath: '/',
          onNavigate,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const setUrl = container.querySelector('[data-testid="browser-toolbar-set-url"]');
    const go = container.querySelector('[data-testid="browser-toolbar-go"]');
    await act(async () => {
      setUrl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      go?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onNavigate.mock.calls).toContainEqual([4173, '/deep']);
  });
});
