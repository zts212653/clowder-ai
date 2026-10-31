import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { SectionGroup } from '../ThreadSidebar/SectionGroup';

function renderToContainer(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

// v12: pin moved back into the "..." context menu (per co-creator feedback).
// Tests open the menu then click the pin MenuItem (matched by label text).

/** Open the project context menu by clicking the "更多操作" trigger. */
function openMenu(container: HTMLElement): void {
  const menuBtn = container.querySelector<HTMLButtonElement>('[data-testid="project-menu-btn"]');
  if (!menuBtn) throw new Error('project-menu-btn not found');
  act(() => {
    menuBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Find a MenuItem button by its text content. Throws if absent. */
function findMenuItemByText(container: HTMLElement, text: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'));
  const match = buttons.find((b) => b.textContent?.trim() === text);
  if (!match) throw new Error(`MenuItem with text "${text}" not found`);
  return match;
}

function renderPinGroup(overrides: { onToggle?: () => void; onPin?: () => void; isProjectPinned?: boolean } = {}) {
  const onPin = overrides.onPin ?? vi.fn();
  const { container } = renderToContainer(
    <SectionGroup
      label="test-project"
      count={3}
      isCollapsed={false}
      onToggle={overrides.onToggle ?? (() => {})}
      onToggleProjectPin={onPin}
      isProjectPinned={overrides.isProjectPinned ?? false}
    >
      <div>child</div>
    </SectionGroup>,
  );
  return { container, onPin };
}

describe('SectionGroup pin (in context menu)', () => {
  it('fires onToggleProjectPin when pin menu item clicked', () => {
    const onPin = vi.fn();
    const { container } = renderPinGroup({ onPin });
    openMenu(container);
    const pinItem = findMenuItemByText(container, '固定项目到活跃区');
    act(() => {
      pinItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('pin menu item click does not trigger parent onToggle', () => {
    const onToggle = vi.fn();
    const onPin = vi.fn();
    const { container } = renderPinGroup({ onToggle, onPin });
    openMenu(container);
    const pinItem = findMenuItemByText(container, '固定项目到活跃区');
    act(() => {
      pinItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('shows "取消固定项目" label when pinned, "固定项目到活跃区" when unpinned', () => {
    const { container: unpinned } = renderPinGroup({ isProjectPinned: false });
    openMenu(unpinned);
    expect(() => findMenuItemByText(unpinned, '固定项目到活跃区')).not.toThrow();

    const { container: pinned } = renderPinGroup({ isProjectPinned: true });
    openMenu(pinned);
    expect(() => findMenuItemByText(pinned, '取消固定项目')).not.toThrow();
  });

  it('pin menu item is a native button (keyboard-accessible by default)', () => {
    const onPin = vi.fn();
    const { container } = renderPinGroup({ onPin });
    openMenu(container);
    const pinItem = findMenuItemByText(container, '固定项目到活跃区');
    expect(pinItem.tagName).toBe('BUTTON');
  });
});
