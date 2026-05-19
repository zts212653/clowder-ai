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

  // Cloud P2: auto-repeat keydown should not re-trigger pin toggle
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
      // First press — should fire
      pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: false }));
      // Auto-repeat events — should be ignored
      pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: true }));
      pinBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: true }));
    });
    expect(onPin).toHaveBeenCalledTimes(1);
  });
});
