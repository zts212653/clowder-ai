/**
 * F246 AC-D3 + F310 compatibility: ActivityBar — Approval Hub bell regression tests.
 *
 * Proves: global Needs Me does not replace the existing approval badge/entry.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---
let mockCount = 0;
let mockWorkspaceMode = 'dev';
let mockRightPanelMode: string = 'status';
let mockRightPanelOpen = false;
let mockActiveSurface: Record<string, unknown> | null = null;
const mockFetchPending = vi.fn();
const mockSetWorkspaceMode = vi.fn((mode: string) => {
  mockWorkspaceMode = mode;
});
const mockSetRightPanelMode = vi.fn((mode: string) => {
  mockRightPanelMode = mode;
});
const mockCloseRightPanel = vi.fn(() => {
  mockRightPanelMode = 'status';
  mockRightPanelOpen = false;
});

vi.mock('@/hooks/useApprovalHub', () => ({
  useApprovalHubSync: vi.fn(),
}));

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ count: mockCount, fetchPending: mockFetchPending }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      workspaceMode: mockWorkspaceMode,
      setWorkspaceMode: mockSetWorkspaceMode,
      rightPanelMode: mockRightPanelMode,
      setRightPanelMode: mockSetRightPanelMode,
      rightPanelOpen: mockRightPanelOpen,
      closeRightPanel: mockCloseRightPanel,
      messages: [],
      currentThreadId: 'default',
    }),
}));

vi.mock('@/components/workbench/experience-workbench-store', () => ({
  useF307ExperienceWorkbenchStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      layout: {
        activeSurfaceId: mockActiveSurface?.id ?? null,
        surfaces: mockActiveSurface ? [mockActiveSurface] : [],
      },
    }),
}));

vi.mock('@/stores/callbackAuthStore', () => ({
  useCallbackAuthAvailable: () => false,
  useCallbackAuthAggregate: () => ({ unviewedFailures24h: 0 }),
}));

vi.mock('@/hooks/useCafeTheme', () => ({
  useCafeTheme: () => ({ toggleTheme: vi.fn(), resolvedTheme: 'light' }),
}));

vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ pinned: [], pin: vi.fn(), unpin: vi.fn(), isPinned: () => false }),
}));

vi.mock('@/components/icons/MemoryIcon', () => ({
  MemoryIcon: () => React.createElement('span', null, 'M'),
}));

vi.mock('@/components/hub-icons', () => ({
  HubIcon: () => React.createElement('span'),
}));

vi.mock('@/components/settings/settings-nav-config', () => ({
  SETTINGS_SECTIONS: [],
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  getThreadIdFromPathname: () => 'default',
}));

import { ActivityBar } from '@/components/ActivityBar';

describe('F246 AC-D3 + F310 compatibility — Approval Hub bell', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockCount = 0;
    mockWorkspaceMode = 'dev';
    mockRightPanelMode = 'status';
    mockRightPanelOpen = false;
    mockActiveSurface = null;
    mockFetchPending.mockClear();
    mockSetWorkspaceMode.mockClear();
    mockSetRightPanelMode.mockClear();
    mockCloseRightPanel.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('preserves the Approval Hub bell for pending approvals outside entrusted work', async () => {
    mockCount = 2;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]');
    const badge = container.querySelector('[data-testid="approval-hub-badge"]');
    expect(bellBtn).not.toBeNull();
    expect(badge?.textContent).toBe('2');

    await act(async () => {
      bellBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mockSetWorkspaceMode).toHaveBeenCalledWith('approval');
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the Approval Hub bell button', async () => {
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]');
    expect(bellBtn).not.toBeNull();
  });

  it('no badge when count=0', async () => {
    mockCount = 0;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const badge = container.querySelector('[data-testid="approval-hub-badge"]');
    expect(badge).toBeNull();
  });

  it('shows badge with count when count > 0', async () => {
    mockCount = 3;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const badge = container.querySelector('[data-testid="approval-hub-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('3');
  });

  it('caps badge at 99+ for count > 99', async () => {
    mockCount = 200;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const badge = container.querySelector('[data-testid="approval-hub-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('99+');
  });

  it('bell click opens Workspace with Approval Hub', async () => {
    mockWorkspaceMode = 'dev';
    mockRightPanelMode = 'status';
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]');
    expect(bellBtn).not.toBeNull();
    await act(async () => {
      bellBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockSetWorkspaceMode).toHaveBeenCalledWith('approval');
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  it('bell click toggles close when already on Approval Hub in Workspace', async () => {
    mockWorkspaceMode = 'approval';
    mockRightPanelMode = 'workspace';
    mockRightPanelOpen = true;
    mockActiveSurface = {
      id: 'workspace:mode:approval',
      renderer: 'workspace-destination',
      objectRef: { kind: 'workspace-destination', id: 'mode:approval' },
      ownerStateRef: { owner: 'f284-workspace-launcher', key: 'mode:approval' },
      resultTargetRef: { owner: 'f284-workspace-launcher', key: 'global:mode:approval' },
    };
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]');
    expect(bellBtn).not.toBeNull();
    await act(async () => {
      bellBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockCloseRightPanel).toHaveBeenCalledTimes(1);
    expect(mockSetRightPanelMode).not.toHaveBeenCalled();
    expect(mockSetWorkspaceMode).not.toHaveBeenCalled();
    expect(mockFetchPending).not.toHaveBeenCalled();
  });

  it('bell closes an inline F307 Approval surface even when the legacy Workspace mode still says Needs Me', async () => {
    mockWorkspaceMode = 'needs-me';
    mockRightPanelMode = 'workspace';
    mockRightPanelOpen = true;
    mockActiveSurface = {
      id: 'workspace:mode:approval',
      renderer: 'workspace-destination',
      objectRef: { kind: 'workspace-destination', id: 'mode:approval' },
      ownerStateRef: { owner: 'f284-workspace-launcher', key: 'mode:approval' },
      resultTargetRef: {
        owner: 'f246-approval-navigation',
        key: encodeURIComponent(JSON.stringify(['global', 'proposal/one'])),
      },
    };
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="approval-hub-button"]')?.click();
    });

    expect(mockCloseRightPanel).toHaveBeenCalledTimes(1);
    expect(mockSetWorkspaceMode).not.toHaveBeenCalled();
    expect(mockFetchPending).not.toHaveBeenCalled();
  });

  it('bell click restores Approval Hub when its right panel chrome is closed', async () => {
    mockWorkspaceMode = 'approval';
    mockRightPanelMode = 'status';
    mockRightPanelOpen = false;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="approval-hub-button"]')?.click();
    });

    expect(mockCloseRightPanel).not.toHaveBeenCalled();
    expect(mockSetWorkspaceMode).toHaveBeenCalledWith('approval');
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  it('bell click focuses Approval Hub instead of closing another F307 tab', async () => {
    mockWorkspaceMode = 'tasks';
    mockRightPanelMode = 'workspace';
    mockRightPanelOpen = true;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="approval-hub-button"]')?.click();
    });

    expect(mockCloseRightPanel).not.toHaveBeenCalled();
    expect(mockSetWorkspaceMode).toHaveBeenCalledWith('approval');
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  it('bell title shows count when pending items exist', async () => {
    mockCount = 7;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]') as HTMLElement;
    expect(bellBtn.getAttribute('title')).toBe('7 项需要处理');
  });

  it('bell title shows generic label when no pending items', async () => {
    mockCount = 0;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]') as HTMLElement;
    expect(bellBtn.getAttribute('title')).toBe('Needs Me');
  });
});
