import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));

describe('ChatContainerHeader safe-area', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('applies top safe-area class so iOS standalone status bar does not overlap header', async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatContainerHeader, {
          sidebarOpen: false,
          onToggleSidebar: vi.fn(),
          threadId: 'default',
          authPendingCount: 0,
          viewMode: 'single',
          onToggleViewMode: vi.fn(),
          onOpenMobileStatus: vi.fn(),
          statusPanelOpen: true,
          onToggleStatusPanel: vi.fn(),
          defaultCatId: 'opus',
        }),
      );
    });

    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expect(header?.className).toContain('safe-area-top');
    expect(header?.className).not.toContain('py-3');

    const innerRow = header?.querySelector('div');
    expect(innerRow).not.toBeNull();
    expect(innerRow?.className).toContain('py-3');
  });
});
