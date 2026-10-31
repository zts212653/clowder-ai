import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';

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

import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { useChatStore } from '@/stores/chatStore';
import { BrowserPanel } from '../BrowserPanel';

describe('BrowserPanel v2 copy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    writeShellPresentation('v2');
    useChatStore.setState({ rightPanelOpen: false, rightPanelMode: 'status', workspaceSurface: 'home' });
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/preview/status') return Promise.reject(new Error('down'));
      return { ok: true, json: async () => ({}) };
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render() {
    await act(async () => {
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible={true}>
          <BrowserPanel />
        </WorkspaceSurfaceVisibilityProvider>,
      );
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  }

  it('shows Chinese gateway error, empty prompt and footer in v2', async () => {
    await render();
    expect(container.textContent).toContain('预览网关不可用');
    expect(container.textContent).toContain('输入 localhost 地址开始预览');
    expect(container.textContent).toContain('暂无预览');
    expect(container.textContent).toContain('打开');
  });

  it('keeps English copy in classic', async () => {
    writeShellPresentation('classic');
    await render();
    expect(container.textContent).toContain('Preview gateway not available');
    expect(container.textContent).toContain('Enter a localhost URL to preview');
    expect(container.textContent).toContain('No preview');
  });

  it('localizes local URL validation errors in v2', async () => {
    await render();
    const goButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '打开');
    expect(goButton).toBeTruthy();
    await act(async () => {
      goButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('请输入有效的 localhost 地址');
    expect(container.textContent).not.toContain('Enter a valid localhost URL');
  });

  it('keeps local validation errors English in classic', async () => {
    writeShellPresentation('classic');
    await render();
    const goButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Go');
    expect(goButton).toBeTruthy();
    await act(async () => {
      goButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('Enter a valid localhost URL');
  });
});
