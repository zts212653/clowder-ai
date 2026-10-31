import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => Promise.reject(new Error('offline'))) }));
vi.mock('../icons/CatCafeLogo', () => ({ CatCafeLogo: () => null }));
vi.mock('../ThreadCatPill', () => ({ ThreadCatPill: () => null }));
vi.mock('../ThreadIndicator', () => ({ ThreadIndicator: () => null, tailTruncate: (value: string) => value }));

import { ChatContainerHeader, PanelToggle } from '../ChatContainerHeader';
import { writeShellPresentation } from '../shell/shell-presentation';

describe('F284 Workspace entry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses one compact icon-only recall control with an activity badge', async () => {
    const onToggleStatusPanel = vi.fn();
    await act(async () => {
      root.render(
        <PanelToggle onToggleStatusPanel={onToggleStatusPanel} statusPanelOpen={false} hasWorkspaceActivity />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>('[data-testid="workspace-panel-toggle"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('');
    expect(button?.querySelector('[data-testid="workspace-activity-badge"]')).not.toBeNull();
    expect(button?.className).not.toContain('hidden');
    expect(button?.className).toContain('z-40');
    expect(button?.className).toContain('bg-transparent');
    expect(button?.className).not.toContain('border');
    expect(button?.dataset.clientInteractive).toBe('true');
  });

  it('keeps one Workspace recall control instead of a second status entry in the header', async () => {
    await act(async () => {
      root.render(
        <ChatContainerHeader
          sidebarOpen={false}
          onToggleSidebar={vi.fn()}
          threadId="thread-status"
          viewMode="single"
          onToggleViewMode={vi.fn()}
          statusPanelOpen={false}
          onToggleStatusPanel={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="workspace-panel-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="status-panel-toggle"]')).toBeNull();
    expect(container.querySelector('button[aria-label="导出对话"]')).toBeNull();
    expect(container.querySelector('button[aria-label="语音陪伴"]')).toBeNull();
    expect(container.querySelector('button[aria-label="会议伴随"]')).toBeNull();
  });

  it('opens message search through its named Host callback without opening Workspace', async () => {
    writeShellPresentation('v2');
    const search = vi.fn();
    const workspace = vi.fn();
    await act(async () =>
      root.render(
        <ChatContainerHeader
          sidebarOpen={false}
          onToggleSidebar={vi.fn()}
          threadId="origin"
          viewMode="single"
          onToggleViewMode={vi.fn()}
          statusPanelOpen={false}
          onToggleStatusPanel={workspace}
          onOpenMessageSearch={search}
          messageSearchOpen
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="查找消息"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    act(() => button?.click());
    expect(search).toHaveBeenCalledOnce();
    expect(workspace).not.toHaveBeenCalled();
  });
  it('keeps classic free of the new message-search entry even when the callback is supplied', async () => {
    await act(async () =>
      root.render(
        <ChatContainerHeader
          sidebarOpen={false}
          onToggleSidebar={vi.fn()}
          threadId="origin"
          viewMode="single"
          onToggleViewMode={vi.fn()}
          statusPanelOpen={false}
          onToggleStatusPanel={vi.fn()}
          onOpenMessageSearch={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="message-search-entry"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-panel-toggle"]')).not.toBeNull();
  });
});
