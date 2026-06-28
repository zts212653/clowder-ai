/**
 * F246 Phase D AC-D2: WorkspaceTabBar vitest regression tests.
 *
 * Proves the three responsive modes (full / overflow / icon-only) driven by
 * ResizeObserver, overflow menu interaction, and active-in-overflow swap.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock ResizeObserver to control width ---
type ResizeCallback = (entries: Array<{ contentRect: { width: number } }>) => void;
let resizeCallback: ResizeCallback | null = null;

class MockResizeObserver {
  constructor(cb: ResizeCallback) {
    resizeCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallback = null;
  }
}

function simulateWidth(width: number) {
  if (resizeCallback) {
    resizeCallback([{ contentRect: { width } }]);
  }
}

// --- Mock chatStore ---
let mockWorkspaceMode = 'dev';
const mockSetWorkspaceMode = vi.fn((mode: string) => {
  mockWorkspaceMode = mode;
});

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      workspaceMode: mockWorkspaceMode,
      setWorkspaceMode: mockSetWorkspaceMode,
    }),
}));

// Import after mocks
import { WorkspaceTabBar } from '../WorkspaceTabBar';

describe('F246 AC-D2: WorkspaceTabBar responsive modes', () => {
  let container: HTMLDivElement;
  let root: Root;
  const origResizeObserver = globalThis.ResizeObserver;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    globalThis.ResizeObserver = origResizeObserver;
  });

  beforeEach(() => {
    mockWorkspaceMode = 'dev';
    mockSetWorkspaceMode.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resizeCallback = null;
  });

  // Constants from WorkspaceTabBar.tsx
  const TABS_COUNT = 8; // dev, recall, schedule, tasks, community, artifacts, approval, trajectory
  const TAB_FULL_WIDTH = 60;
  const TAB_ICON_WIDTH = 32;
  const GAP_WIDTH = 4;
  const OVERFLOW_WIDTH = 32;
  const CONTAINER_PADDING = 24;
  // allFitFull threshold: TABS*60 + (TABS-1)*4 + PADDING = 508 + 24 = 532
  const FULL_WIDTH = TABS_COUNT * TAB_FULL_WIDTH + (TABS_COUNT - 1) * GAP_WIDTH + CONTAINER_PADDING;
  // iconOnly threshold: TABS*32 + (TABS-1)*4 + 32 + PADDING = 316 + 24 = 340
  const ICON_ONLY_THRESHOLD =
    TABS_COUNT * TAB_ICON_WIDTH + (TABS_COUNT - 1) * GAP_WIDTH + OVERFLOW_WIDTH + CONTAINER_PADDING;

  it('wide width → all tab labels visible, no overflow button', async () => {
    await act(async () => {
      root.render(React.createElement(WorkspaceTabBar));
    });
    await act(async () => {
      simulateWidth(FULL_WIDTH + 100);
    });

    const bar = container.querySelector('[data-testid="workspace-tab-bar"]');
    expect(bar).not.toBeNull();

    // All 8 tabs should be visible as buttons
    const tabs = container.querySelectorAll('button[data-testid^="workspace-tab-"]');
    // Filter out overflow button and overflow menu items
    const mainTabs = Array.from(tabs).filter((t) => {
      const tid = t.getAttribute('data-testid') ?? '';
      return !tid.includes('overflow');
    });
    expect(mainTabs.length).toBe(TABS_COUNT);

    // No overflow button
    const overflowBtn = container.querySelector('[data-testid="workspace-tab-overflow-btn"]');
    expect(overflowBtn).toBeNull();

    // Labels should be text-visible (not icon-only)
    const devTab = container.querySelector('[data-testid="workspace-tab-dev"]');
    expect(devTab?.textContent).toContain('开发');
    // icon-only mode sets title attribute; full mode does not
    expect(devTab?.getAttribute('title')).toBeNull();
  });

  it('medium width → visible tabs + overflow menu, labels still shown', async () => {
    await act(async () => {
      root.render(React.createElement(WorkspaceTabBar));
    });
    // Width between icon-only threshold and full threshold → overflow mode
    const mediumWidth = Math.floor((ICON_ONLY_THRESHOLD + FULL_WIDTH) / 2);
    await act(async () => {
      simulateWidth(mediumWidth);
    });

    // Overflow button must exist
    const overflowBtn = container.querySelector('[data-testid="workspace-tab-overflow-btn"]');
    expect(overflowBtn).not.toBeNull();

    // Some tabs visible inline, some in overflow
    const inlineTabs = container.querySelectorAll(
      'button[data-testid^="workspace-tab-"]:not([data-testid*="overflow"])',
    );
    expect(inlineTabs.length).toBeGreaterThan(0);
    expect(inlineTabs.length).toBeLessThan(TABS_COUNT);

    // Labels should still be visible (not icon-only)
    const firstTab = inlineTabs[0];
    expect(firstTab?.getAttribute('title')).toBeNull();
  });

  it('narrow width → icon-only mode with accessible title attributes', async () => {
    await act(async () => {
      root.render(React.createElement(WorkspaceTabBar));
    });
    // Below icon-only threshold
    await act(async () => {
      simulateWidth(ICON_ONLY_THRESHOLD - 50);
    });

    // Tabs should have title attributes (icon-only provides label via title)
    const devTab = container.querySelector('[data-testid="workspace-tab-dev"]');
    expect(devTab).not.toBeNull();
    expect(devTab?.getAttribute('title')).toBe('开发');

    // Text content should NOT contain the label text (icon-only hides it)
    // The tab should only contain the icon, not the label text
    expect(devTab?.textContent).not.toContain('开发');
  });

  it('overflow tab click → mode changes and dropdown closes', async () => {
    await act(async () => {
      root.render(React.createElement(WorkspaceTabBar));
    });
    // Set medium width to create overflow
    const mediumWidth = Math.floor((ICON_ONLY_THRESHOLD + FULL_WIDTH) / 2);
    await act(async () => {
      simulateWidth(mediumWidth);
    });

    // Open overflow menu
    const overflowBtn = container.querySelector('[data-testid="workspace-tab-overflow-btn"]');
    expect(overflowBtn).not.toBeNull();
    await act(async () => {
      overflowBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Overflow menu should be open
    const overflowMenu = container.querySelector('[data-testid="workspace-tab-overflow-menu"]');
    expect(overflowMenu).not.toBeNull();

    // Click an item in the overflow menu
    const overflowItems = overflowMenu!.querySelectorAll('button');
    expect(overflowItems.length).toBeGreaterThan(0);
    const firstOverflowItem = overflowItems[0];
    await act(async () => {
      firstOverflowItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // setWorkspaceMode should have been called
    expect(mockSetWorkspaceMode).toHaveBeenCalled();

    // Dropdown should be closed after click
    const menuAfterClick = container.querySelector('[data-testid="workspace-tab-overflow-menu"]');
    expect(menuAfterClick).toBeNull();
  });

  it('active tab in overflow → swapped into visible range', async () => {
    // Set workspace mode to the last tab (trajectory) which will be in overflow at medium width
    mockWorkspaceMode = 'trajectory';
    await act(async () => {
      root.render(React.createElement(WorkspaceTabBar));
    });
    const mediumWidth = Math.floor((ICON_ONLY_THRESHOLD + FULL_WIDTH) / 2);
    await act(async () => {
      simulateWidth(mediumWidth);
    });

    // trajectory should be visible as an inline tab (swapped in from overflow)
    const trajectoryTab = container.querySelector('[data-testid="workspace-tab-trajectory"]');
    expect(trajectoryTab).not.toBeNull();

    // And it should NOT be in the overflow menu
    const overflowBtn = container.querySelector('[data-testid="workspace-tab-overflow-btn"]');
    if (overflowBtn) {
      await act(async () => {
        overflowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const overflowTrajectory = container.querySelector('[data-testid="workspace-tab-overflow-trajectory"]');
      expect(overflowTrajectory).toBeNull();
    }
  });

  it('approval tab has correct data-testid', async () => {
    mockWorkspaceMode = 'approval';
    await act(async () => {
      root.render(React.createElement(WorkspaceTabBar));
    });
    // Default width starts at 9999 (wide), so all tabs visible
    const approvalTab = container.querySelector('[data-testid="workspace-tab-approval"]');
    expect(approvalTab).not.toBeNull();
    expect(approvalTab?.textContent).toContain('审批');
  });
});
