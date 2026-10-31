import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { _resetCatDataCache } from '@/hooks/useCatData';
import { AgentPaneViewer } from '../AgentPaneViewer';
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

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 0;
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

const CATS = {
  cats: [
    {
      id: 'kimi',
      displayName: '梵花猫',
      color: { primary: '#123456', secondary: '#abcdef' },
      mentionPatterns: [],
      carrier: 'cli',
      clientId: 'kimi-code',
      defaultModel: 'k3',
    },
  ],
};

describe('code tools v2 copy (A-pattern components)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    _resetCatDataCache();
    FakeWebSocket.instances = [];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/terminal/agent-panes')) return Response.json([]);
      if (url.includes('/api/cats')) return Response.json(CATS);
      return new Response('not found', { status: 404 });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    _resetCatDataCache();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(node: React.ReactElement) {
    await act(async () => {
      root.render(<WorkspaceSurfaceVisibilityProvider visible={true}>{node}</WorkspaceSurfaceVisibilityProvider>);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  }

  it('BrowserToolbar uses Chinese tooltips and 打开 when the panel passes v2 copy', async () => {
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
        copy={codeToolsCopy.zh.preview}
      />,
    );
    expect(container.querySelector('button[title="后退"]')).toBeTruthy();
    expect(container.querySelector('button[title="前进"]')).toBeTruthy();
    expect(container.querySelector('button[title="刷新"]')).toBeTruthy();
    expect(container.querySelector('button[title="截图"]')).toBeTruthy();
    expect(container.querySelector('button[title="控制台"]')).toBeTruthy();
    expect(container.textContent).toContain('打开');
  });

  it('BrowserToolbar keeps classic literals with no copy prop, in either presentation', async () => {
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
    expect(container.querySelector('button[title="Back"]')).toBeTruthy();
    expect(container.textContent).toContain('Go');
  });

  it('BrowserTabBar uses the supplied Chinese titles and render-time default tab title', async () => {
    await render(
      <BrowserTabBar
        tabs={[{ id: 'tab-1', port: 0, path: '/', title: null }]}
        activeTabId="tab-1"
        onSelect={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
        defaultTitle={codeToolsCopy.zh.preview.newTabTitle}
        addTitle={codeToolsCopy.zh.preview.newTab}
      />,
    );
    expect(container.querySelector('button[title="新建标签页"]')).toBeTruthy();
    expect(container.textContent).toContain('新标签页');
  });

  it('BrowserTabBar keeps classic literals by default', async () => {
    writeShellPresentation('classic');
    await render(
      <BrowserTabBar
        tabs={[{ id: 'tab-1', port: 0, path: '/', title: null }]}
        activeTabId="tab-1"
        onSelect={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(container.querySelector('button[title="New tab"]')).toBeTruthy();
    expect(container.textContent).toContain('New Tab');
  });

  it('TerminalTab shows 我的终端 · 已断开 with Chinese actions when the session fails to connect', async () => {
    await render(<TerminalTab worktreeId="wt-1" />);
    expect(container.textContent).toContain('我的终端 · 已断开');
    expect(container.textContent).toContain('重新连接');
    expect(container.textContent).toContain('关闭终端');
  });

  it('TerminalTab keeps English status in classic', async () => {
    writeShellPresentation('classic');
    await render(<TerminalTab worktreeId="wt-1" />);
    expect(container.textContent).toContain('Disconnected');
    expect(container.textContent).toContain('Reconnect');
  });

  it('AgentPaneViewer v2 shows 返回我的终端 / 只读 / 连接中…', async () => {
    await render(<AgentPaneViewer worktreeId="wt-1" paneId="pane-9" onBack={() => {}} />);
    expect(container.textContent).toContain('返回我的终端');
    expect(container.textContent).toContain('只读');
    expect(container.textContent).toContain('连接中…');
  });

  it('AgentPaneViewer v2 resolves the cat name once watching', async () => {
    await render(<AgentPaneViewer worktreeId="wt-1" paneId="pane-9" catId="kimi" onBack={() => {}} />);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeTruthy();
    await act(async () => {
      ws.onopen?.();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('正在查看 梵花猫');
  });

  it('AgentPaneViewer keeps English chrome in classic', async () => {
    writeShellPresentation('classic');
    await render(<AgentPaneViewer worktreeId="wt-1" paneId="pane-9" onBack={() => {}} />);
    expect(container.textContent).toContain('Back to shell');
    expect(container.textContent).toContain('read-only');
  });
});
