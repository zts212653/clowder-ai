/**
 * F246 Phase D AC-D3: ActivityBar — ApprovalHubButton vitest regression tests.
 *
 * Proves: bell icon renders, badge count, bell click → workspace approval tab,
 * toggle close when already on approval tab.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---
let mockCount = 0;
const mockFetchPending = vi.fn();
let mockWorkspaceMode = 'dev';
let mockRightPanelMode: string = 'status';
const mockSetWorkspaceMode = vi.fn((mode: string) => {
  mockWorkspaceMode = mode;
});
const mockSetRightPanelMode = vi.fn((mode: string) => {
  mockRightPanelMode = mode;
});

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items: [],
      count: mockCount,
      isLoading: false,
      isOpen: false,
      error: null,
      deciding: {},
      fetchPending: mockFetchPending,
      open: vi.fn(),
      close: vi.fn(),
      toggle: vi.fn(),
    }),
}));

vi.mock('@/hooks/useApprovalHub', () => ({
  useApprovalHubSync: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      workspaceMode: mockWorkspaceMode,
      setWorkspaceMode: mockSetWorkspaceMode,
      rightPanelMode: mockRightPanelMode,
      setRightPanelMode: mockSetRightPanelMode,
      messages: [],
      currentThreadId: 'default',
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

describe('F246 AC-D3: ActivityBar — ApprovalHubButton', () => {
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
    mockFetchPending.mockClear();
    mockSetWorkspaceMode.mockClear();
    mockSetRightPanelMode.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders approval hub bell button', async () => {
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

  it('bell click opens workspace with approval tab', async () => {
    mockWorkspaceMode = 'dev';
    mockRightPanelMode = 'status';
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]');
    await act(async () => {
      bellBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockSetWorkspaceMode).toHaveBeenCalledWith('approval');
    expect(mockFetchPending).toHaveBeenCalled();
  });

  it('bell click toggles close when already on approval tab in workspace', async () => {
    mockWorkspaceMode = 'approval';
    mockRightPanelMode = 'workspace';
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]');
    await act(async () => {
      bellBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Should toggle to status (close workspace)
    expect(mockSetRightPanelMode).toHaveBeenCalledWith('status');
    // Should NOT call setWorkspaceMode again
    expect(mockSetWorkspaceMode).not.toHaveBeenCalled();
  });

  it('bell title shows count when pending items exist', async () => {
    mockCount = 7;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]') as HTMLElement;
    expect(bellBtn.getAttribute('title')).toBe('7 项待审批');
  });

  it('bell title shows generic label when no pending items', async () => {
    mockCount = 0;
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });

    const bellBtn = container.querySelector('[data-testid="approval-hub-button"]') as HTMLElement;
    expect(bellBtn.getAttribute('title')).toBe('审批中心');
  });
});
