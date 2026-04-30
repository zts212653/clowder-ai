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

describe('SectionGroup pin button', () => {
  // P2: pin button must respond to Space key (ARIA role="button" requirement)
  it('fires onToggleProjectPin on Space key press', () => {
    const onPin = vi.fn();
    const { container } = renderToContainer(
      <SectionGroup
        label="test-project"
        count={3}
        isCollapsed={false}
        onToggle={() => {}}
        onToggleProjectPin={onPin}
        isProjectPinned={false}
      >
        <div>child</div>
      </SectionGroup>,
    );
    const pinBtn = container.querySelector('[data-testid="project-pin-btn"]')!;
    act(() => {
      pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('fires onToggleProjectPin on Enter key press', () => {
    const onPin = vi.fn();
    const { container } = renderToContainer(
      <SectionGroup
        label="test-project"
        count={3}
        isCollapsed={false}
        onToggle={() => {}}
        onToggleProjectPin={onPin}
        isProjectPinned={false}
      >
        <div>child</div>
      </SectionGroup>,
    );
    const pinBtn = container.querySelector('[data-testid="project-pin-btn"]')!;
    act(() => {
      pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('pin button click does not trigger parent onToggle', () => {
    const onToggle = vi.fn();
    const onPin = vi.fn();
    const { container } = renderToContainer(
      <SectionGroup
        label="test-project"
        count={3}
        isCollapsed={false}
        onToggle={onToggle}
        onToggleProjectPin={onPin}
        isProjectPinned={false}
      >
        <div>child</div>
      </SectionGroup>,
    );
    const pinBtn = container.querySelector('[data-testid="project-pin-btn"]')!;
    act(() => {
      pinBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('ignores repeated Space keydown events (key held down)', () => {
    const onPin = vi.fn();
    const { container } = renderToContainer(
      <SectionGroup
        label="test-project"
        count={3}
        isCollapsed={false}
        onToggle={() => {}}
        onToggleProjectPin={onPin}
        isProjectPinned={false}
      >
        <div>child</div>
      </SectionGroup>,
    );
    const pinBtn = container.querySelector('[data-testid="project-pin-btn"]')!;
    act(() => {
      pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: false }));
      pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: true }));
      pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: true }));
    });
    expect(onPin).toHaveBeenCalledTimes(1);
  });
});

describe('SectionGroup toggle button accessibility', () => {
  it('toggle button is keyboard-focusable and has aria-expanded', () => {
    const { container } = renderToContainer(
      <SectionGroup label="Test" count={2} isCollapsed={false} onToggle={() => {}}>
        <div>child</div>
      </SectionGroup>,
    );
    const toggleBtn = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
  });

  it('toggle button aria-expanded reflects collapsed state', () => {
    const { container } = renderToContainer(
      <SectionGroup label="Test" count={2} isCollapsed={true} onToggle={() => {}}>
        <div>child</div>
      </SectionGroup>,
    );
    const toggleBtn = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('fires onToggle when Enter is pressed on toggle button', () => {
    const onToggle = vi.fn();
    const { container } = renderToContainer(
      <SectionGroup label="Test" count={2} isCollapsed={false} onToggle={onToggle}>
        <div>child</div>
      </SectionGroup>,
    );
    const toggleBtn = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    act(() => {
      toggleBtn.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('action buttons are siblings of toggle, not children (no button-in-button)', () => {
    const { container } = renderToContainer(
      <SectionGroup
        label="Test"
        count={2}
        isCollapsed={false}
        onToggle={() => {}}
        onToggleProjectPin={() => {}}
        isProjectPinned={false}
        onQuickCreate={() => {}}
      >
        <div>child</div>
      </SectionGroup>,
    );
    const toggleBtn = container.querySelector('button[aria-expanded]')!;
    const nestedInteractive = toggleBtn.querySelectorAll('[role="button"], button, input, select, textarea');
    expect(nestedInteractive.length).toBe(0);
  });

  it('quick-create click does not trigger onToggle', () => {
    const onToggle = vi.fn();
    const onCreate = vi.fn();
    const { container } = renderToContainer(
      <SectionGroup label="Test" count={2} isCollapsed={false} onToggle={onToggle} onQuickCreate={onCreate}>
        <div>child</div>
      </SectionGroup>,
    );
    const createBtn = container.querySelector('[data-testid="quick-create-btn"]')!;
    act(() => {
      createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
