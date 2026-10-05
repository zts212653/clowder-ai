import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../SidebarTabIcon', () => ({ SidebarTabIcon: () => null }));
vi.mock('../LabelFilterBar', () => ({
  LabelFilterBar: ({ selectedFilter }: { selectedFilter: string | null }) => (
    <button type="button" data-testid="sidebar-label-filter-trigger" data-filter={selectedFilter ?? ''}>
      标签
    </button>
  ),
}));

import { SidebarViewBarV2 } from '../SidebarViewBarV2';
import type { SidebarTab } from '../thread-utils';

const tabs: SidebarTab[] = [
  { id: 'pinned', label: '置顶', count: 0 },
  { id: 'recent', label: '最近', count: 485 },
  { id: 'project', label: '项目', count: 42 },
  { id: 'system', label: '系统', count: 15 },
  { id: 'favorites', label: '收藏', count: 3 },
] as SidebarTab[];

describe('F322 list head: one 分组 menu over the same tab state', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onSelectTab = vi.fn();
  const onLabelFilter = vi.fn();
  const render = (activeTab = 'recent') =>
    act(() =>
      root.render(
        <SidebarViewBarV2
          tabs={tabs}
          activeTab={activeTab as SidebarTab['id']}
          onSelectTab={onSelectTab}
          labels={[]}
          labelFilter={null}
          onLabelFilter={onLabelFilter}
          uncategorizedCount={0}
        />,
      ),
    );
  const menu = () => host.querySelector('[role="menu"]');
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows the current grouping, not six tabs, until opened', () => {
    render('project');
    expect(host.querySelector('[data-testid="sidebar-view-menu"]')?.textContent).toContain('项目');
    expect(menu()).toBeNull();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="sidebar-label-filter-trigger"]')).not.toBeNull();
  });

  it('lists every grouping with its real count and marks the current one', () => {
    render('recent');
    act(() => host.querySelector<HTMLElement>('[data-testid="sidebar-view-menu"]')?.click());
    const items = [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(items.map((item) => item.textContent)).toEqual(['置顶0', '最近485', '项目42', '系统15', '收藏3']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
      'false',
    ]);
  });

  it('choosing a grouping calls the original tab handler with the original tab id and closes the menu', () => {
    render('recent');
    act(() => host.querySelector<HTMLElement>('[data-testid="sidebar-view-menu"]')?.click());
    act(() => host.querySelector<HTMLElement>('[data-testid="sidebar-tab-project"]')?.click());
    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onSelectTab).toHaveBeenCalledWith('project');
    expect(menu()).toBeNull();
  });

  it('Escape closes the menu; the trigger carries no native title', () => {
    render();
    const trigger = host.querySelector<HTMLElement>('[data-testid="sidebar-view-menu"]');
    expect(trigger?.getAttribute('title')).toBeNull();
    act(() => trigger?.click());
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
  });
});
