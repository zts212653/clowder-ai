import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let mockCount = 0;
let mockWorkspaceMode = 'dev';
let mockRightPanelMode: string = 'status';
let mockRightPanelOpen = false;
let mockActiveSurface: Record<string, unknown> | null = null;
let mockNeedsMeCount = 0;
let mockNeedsMeLoading = false;
let mockNeedsMeError = false;
let mockApprovalUnavailable: 'loading' | 'error' | null = null;
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

vi.mock('@/hooks/useEntrustedWorkProjection', () => ({
  useEntrustedWorkProjection: (projection: string) => {
    if (projection !== 'needs-me') throw new Error(`unexpected projection: ${projection}`);
    return {
      ownerReads: [],
      loading: mockNeedsMeLoading,
      error: mockNeedsMeError,
      refetch: vi.fn(),
    };
  },
}));

vi.mock('@/components/growing/needs-me-items', () => ({
  selectNeedsMeItems: () => Array.from({ length: mockNeedsMeCount }),
}));

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      count: mockCount,
      isLoading: mockApprovalUnavailable === 'loading',
      error: mockApprovalUnavailable === 'error' ? 'unavailable' : null,
      fetchPending: mockFetchPending,
    }),
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

describe('F246 AC-D3 + F310 — distinct attention entries', () => {
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
    mockNeedsMeCount = 0;
    mockNeedsMeLoading = false;
    mockNeedsMeError = false;
    mockApprovalUnavailable = null;
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
    expect(bellBtn?.getAttribute('aria-label')).toBe('审批');
    expect(bellBtn?.getAttribute('title')).toBe('审批');
    expect(container.querySelector('[data-testid="approval-hub-badge"]')).toBeNull();
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

  it('Approval title and aria expose only the Approval count', async () => {
    mockCount = 7;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]') as HTMLElement;
    expect(bellBtn.getAttribute('title')).toBe('审批 · 7 项待处理');
    expect(bellBtn.getAttribute('aria-label')).toBe('审批，7 项待处理');
  });

  it.each(['loading', 'error'] as const)('hides a stale Approval count while its read is %s', async (state) => {
    mockCount = 2;
    mockApprovalUnavailable = state;
    await act(async () => root.render(React.createElement(ActivityBar)));
    const bell = container.querySelector('[data-testid="approval-hub-button"]') as HTMLElement;
    const expectedLabel = state === 'loading' ? '审批正在读取' : '审批暂时不可用';
    expect(bell.getAttribute('title')).toBe(expectedLabel);
    expect(bell.getAttribute('aria-label')).toBe(expectedLabel);
    expect(container.querySelector('[data-testid="approval-hub-badge"]')).toBeNull();
  });

  it('keeps a stable Needs Me entry at zero without inventing a badge', async () => {
    mockCount = 0;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const needsMeButton = container.querySelector('[data-testid="needs-me-button"]') as HTMLElement;
    expect(needsMeButton).not.toBeNull();
    expect(needsMeButton.getAttribute('title')).toBe('Needs Me');
    expect(needsMeButton.getAttribute('aria-label')).toBe('Needs Me');
    expect(container.querySelector('[data-testid="needs-me-badge"]')).toBeNull();
    await act(async () => {
      needsMeButton.click();
    });
    expect(mockSetWorkspaceMode).toHaveBeenCalledWith('needs-me');
    expect(mockFetchPending).not.toHaveBeenCalled();
  });

  it('shows simultaneous Approval and Needs Me counts as separate truths', async () => {
    mockCount = 2;
    mockNeedsMeCount = 3;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const approvalButton = container.querySelector<HTMLButtonElement>('[data-testid="approval-hub-button"]');
    const needsMeButton = container.querySelector<HTMLButtonElement>('[data-testid="needs-me-button"]');
    expect(container.querySelector('[data-testid="approval-hub-badge"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="needs-me-badge"]')?.textContent).toBe('3');
    expect(approvalButton?.getAttribute('title')).toBe('审批 · 2 项待处理');
    expect(needsMeButton?.getAttribute('title')).toBe('Needs Me · 3 项待处理');

    await act(async () => approvalButton?.click());
    await act(async () => needsMeButton?.click());
    expect(mockSetWorkspaceMode).toHaveBeenNthCalledWith(1, 'approval');
    expect(mockSetWorkspaceMode).toHaveBeenNthCalledWith(2, 'needs-me');
  });

  it('does not present a stale Needs Me count while its owner projection is unavailable', async () => {
    mockNeedsMeCount = 1;
    mockNeedsMeError = true;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const needsMeButton = container.querySelector('[data-testid="needs-me-button"]') as HTMLElement;
    expect(needsMeButton.getAttribute('title')).toBe('Needs Me 暂时不可用');
    expect(container.querySelector('[data-testid="needs-me-badge"]')).toBeNull();
  });
});
