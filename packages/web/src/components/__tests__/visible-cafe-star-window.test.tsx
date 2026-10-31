import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StarWindow } from '@/components/visible-cafe/StarWindow';

describe('F258 StarWindow discoverability', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
  });

  it('renders a visible planet affordance and preserves the touch-first click target', () => {
    const onStarClick = vi.fn();
    React.act(() => {
      root.render(
        <StarWindow
          starLights={[{ threadId: 'thread-visible-planet', brightness: 0.75, x: 0.4, y: 0.6 }]}
          isQuiet={false}
          onStarClick={onStarClick}
        />,
      );
    });

    expect(container.textContent).toContain('亮着的星球可以点开');
    const button = container.querySelector<HTMLButtonElement>('button[aria-label^="打开猫猫星球"]');
    expect(button).toBeTruthy();
    expect(Number.parseFloat(button?.style.width ?? '0')).toBeGreaterThanOrEqual(44);

    const marker = button?.querySelector<HTMLElement>('[data-star-marker]');
    expect(marker).toBeTruthy();
    expect(Number.parseFloat(marker?.style.width ?? '0')).toBeGreaterThanOrEqual(12);

    React.act(() => button?.click());
    expect(onStarClick).toHaveBeenCalledWith('thread-visible-planet');
  });

  it('keeps the window legible when no thread is currently active', () => {
    React.act(() => {
      root.render(<StarWindow starLights={[]} isQuiet={false} onStarClick={vi.fn()} />);
    });

    expect(container.textContent).toContain('窗外的星球现在都暗着');
  });
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined;
});
