import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { _resetCatDataCache } from '@/hooks/useCatData';
import { AgentPaneList } from '../AgentPaneList';
import { ConsolePanel } from '../ConsolePanel';
import { TerminalTab } from '../TerminalTab';

Object.assign(globalThis as Record<string, unknown>, { React });

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  API_URL: 'http://localhost:3003',
}));

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

const PANES = [{ invocationId: 'inv-alpha-1', paneId: 'pane-1', status: 'running', startedAt: 1, catId: null }];
const CATS = { cats: [] };

describe('code tools v2 in English (shell-language)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    writeShellLanguage('en');
    _resetCatDataCache();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/terminal/agent-panes')) return Response.json(PANES);
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
    writeShellLanguage('zh');
    _resetCatDataCache();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(node: React.ReactElement) {
    await act(async () => {
      root.render(<WorkspaceSurfaceVisibilityProvider visible={true}>{node}</WorkspaceSurfaceVisibilityProvider>);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  }

  it('AgentPaneList reads the English dictionary in v2', async () => {
    await render(<AgentPaneList worktreeId="wt-1" onSelectPane={() => {}} />);
    expect(container.textContent).toContain("Cats' terminals 1");
    expect(container.textContent).toContain('Running');
    expect(container.textContent).not.toContain('猫的终端');
  });

  it('TerminalTab reads the English dictionary in v2', async () => {
    await render(<TerminalTab worktreeId="wt-1" />);
    expect(container.textContent).toContain('My terminal · Disconnected');
    expect(container.textContent).toContain('Reconnect');
    expect(container.textContent).toContain('Close terminal');
  });

  it('ConsolePanel reads the English dictionary in v2', async () => {
    await render(
      <ConsolePanel
        entries={[
          { level: 'log', args: ['hello'], timestamp: 1 },
          { level: 'error', args: ['broken'], timestamp: 2 },
        ]}
        onClear={() => {}}
      />,
    );
    expect(container.textContent).toContain('Console');
    expect(container.textContent).toContain('All');
    expect(container.textContent).toContain('Errors');
    expect(container.textContent).toContain('Log');
    expect(container.textContent).toContain('Error');
  });

  it('classic surfaces keep their own literals and never read the dictionary', async () => {
    writeShellPresentation('classic');
    await render(<TerminalTab worktreeId="wt-1" />);
    expect(container.textContent).toContain('Disconnected');
    expect(container.textContent).toContain('Reconnect');
    expect(container.textContent).not.toContain('My terminal ·');
  });
});
