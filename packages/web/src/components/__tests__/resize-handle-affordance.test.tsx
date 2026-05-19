import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from '@/components/workspace/ResizeHandle';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('ResizeHandle affordance', () => {
  it('exposes a visible resize/collapse affordance and collapses on click', () => {
    const onResize = vi.fn();
    const onCollapse = vi.fn();

    act(() => {
      root.render(
        <ResizeHandle
          direction="horizontal"
          label="左侧对话栏"
          onResize={onResize}
          onCollapse={onCollapse}
          onDoubleClick={vi.fn()}
        />,
      );
    });

    const handle = container.querySelector('[role="separator"]') as HTMLElement;
    expect(handle).toBeTruthy();
    expect(handle.getAttribute('aria-label')).toContain('左侧对话栏');
    expect(handle.textContent).toContain('点击折叠');
    expect(handle.textContent).toContain('拖动调整');

    act(() => {
      handle.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100 }));
    });
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('resizes on drag without also collapsing on mouseup click', () => {
    const onResize = vi.fn();
    const onCollapse = vi.fn();

    act(() => {
      root.render(
        <ResizeHandle
          direction="horizontal"
          label="右侧状态栏"
          onResize={onResize}
          onCollapse={onCollapse}
          onDoubleClick={vi.fn()}
        />,
      );
    });

    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 124 }));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 124 }));
    });
    act(() => {
      handle.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 124 }));
    });
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(onResize).toHaveBeenCalledWith(24);
    expect(onCollapse).not.toHaveBeenCalled();
  });
});
