import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellCopy } from '@/components/shell/shell-copy';
import { SHELL_LANGUAGE_STORAGE_KEY, writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { _resetCatDataCache } from '@/hooks/useCatData';
import { AgentPaneViewer } from '../AgentPaneViewer';
import { BrowserPanel, type BrowserTab } from '../BrowserPanel';
import { BrowserTabBar } from '../BrowserTabBar';
import { BrowserToolbar } from '../BrowserToolbar';
import { codeToolsCopy } from '../code-tools.shell-copy';
import { TerminalTab } from '../TerminalTab';

Object.assign(globalThis as Record<string, unknown>, { React });

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  API_URL: 'http://localhost:3003',
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

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
}
vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

// Mirrors the wiring inside BrowserPanel: the V2 panel passes the dictionary's
// new-tab strings into the tab bar, and an untitled tab renders the default.
function TabBarHarness() {
  const copy = useShellCopy(codeToolsCopy).preview;
  const [tabs, setTabs] = React.useState<BrowserTab[]>([{ id: 'tab-1', port: 0, path: '/', title: null }]);
  return (
    <BrowserTabBar
      tabs={tabs}
      activeTabId={tabs[tabs.length - 1]?.id ?? null}
      onSelect={() => {}}
      onClose={() => {}}
      onAdd={() => setTabs((prev) => [...prev, { id: `tab-${prev.length + 1}`, port: 0, path: '/', title: null }])}
      defaultTitle={copy.newTabTitle}
      addTitle={copy.newTab}
    />
  );
}
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});

describe('code tools language contract (R2)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    _resetCatDataCache();
    FakeWebSocket.instances = [];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/terminal/agent-panes')) return Response.json([]);
      if (url.includes('/api/cats')) return Response.json({ cats: [] });
      return { ok: true, json: async () => ({}) };
    });
    getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    getItemSpy.mockRestore();
    writeShellPresentation('classic');
    writeShellLanguage('zh');
    _resetCatDataCache();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(node: React.ReactElement) {
    await act(async () => {
      root.render(<WorkspaceSurfaceVisibilityProvider visible={true}>{node}</WorkspaceSurfaceVisibilityProvider>);
      for (let i = 0; i < 14; i++) await Promise.resolve();
    });
  }

  function languageReads(): number {
    return getItemSpy.mock.calls.filter((call: unknown[]) => call[0] === SHELL_LANGUAGE_STORAGE_KEY).length;
  }

  it('classic entry points never read the v2 language preference', async () => {
    writeShellPresentation('classic');
    await render(
      <BrowserToolbar
        urlInput=""
        onUrlChange={() => {}}
        onNavigate={() => {}}
        onBack={() => {}}
        onForward={() => {}}
        onRefresh={() => {}}
        onScreenshot={() => {}}
        isCapturing={false}
        hasTarget={true}
        consoleOpen={false}
        onConsoleToggle={() => {}}
        consoleCount={0}
      />,
    );
    await render(
      <BrowserTabBar tabs={[]} activeTabId={null} onSelect={() => {}} onClose={() => {}} onAdd={() => {}} />,
    );
    await render(<TerminalTab worktreeId="wt-1" />);
    await render(<AgentPaneViewer worktreeId="wt-1" paneId="pane-1" onBack={() => {}} />);
    await render(<BrowserPanel />);
    expect(languageReads()).toBe(0);
  });

  it('v2 entry points read the preference exactly through the dictionary boundary', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/terminal/sessions') && init?.method === 'POST') {
        return new Response('x', { status: 500 });
      }
      if (url.includes('/api/terminal/agent-panes')) return Response.json([]);
      if (url.includes('/api/cats')) return Response.json({ cats: [] });
      return { ok: true, json: async () => ({}) };
    });
    writeShellPresentation('v2');
    writeShellLanguage('en');
    await render(<TerminalTab worktreeId="wt-1" />);
    expect(languageReads()).toBeGreaterThan(0);
    expect(container.textContent).toContain('My terminal · Disconnected');
  });

  it('switching language re-words the connected terminal without rebuilding its socket', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/terminal/sessions') && init?.method === 'POST') {
        return Response.json({ sessionId: 'sess-1', paneId: '%9', reconnected: false });
      }
      if (url.includes('/api/terminal/agent-panes')) return Response.json([]);
      if (url.includes('/api/cats')) return Response.json({ cats: [] });
      return { ok: true, json: async () => ({}) };
    });
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    await render(<TerminalTab worktreeId="wt-1" />);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeTruthy();
    await act(async () => {
      ws.onopen?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('我的终端 · 已连接');

    const socketsBefore = FakeWebSocket.instances.length;
    await act(async () => {
      writeShellLanguage('en');
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('My terminal · Connected');
    expect(FakeWebSocket.instances.length).toBe(socketsBefore);
  });

  it('preview validation errors and default tab titles follow the current language', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    await render(<BrowserPanel />);
    const goButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '打开');
    await act(async () => {
      goButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('请输入有效的 localhost 地址');

    await act(async () => {
      writeShellLanguage('en');
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('Enter a valid localhost URL');
    expect(container.textContent).not.toContain('请输入有效的 localhost 地址');

    // Default tab titles: same wiring as BrowserPanel (untitled tab renders the
    // dictionary's newTabTitle), verified across a language switch.
    await render(<TabBarHarness />);
    expect(container.textContent).toContain('New tab');
    expect(container.textContent).not.toContain('新标签页');
    const addTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '+');
    await act(async () => {
      addTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(container.querySelectorAll('button').length).toBe(3);

    await act(async () => {
      writeShellLanguage('zh');
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('新标签页');
    expect(container.textContent).not.toContain('New Tab');

    // Round trip: back in zh, a fresh validation error is zh again.
    await render(<BrowserPanel />);
    const goAgain = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '打开');
    await act(async () => {
      goAgain?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('请输入有效的 localhost 地址');
  });
});
