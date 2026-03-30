import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickCreateForm } from '@/components/mission-control/QuickCreateForm';

describe('QuickCreateForm IME guard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('blocks Enter default in title/summary/tags inputs while composing', async () => {
    const onCreate = vi.fn(async () => {});

    await act(async () => {
      root.render(<QuickCreateForm onCreate={onCreate} />);
    });

    const selectors = [
      '[data-testid="mc-create-title"]',
      '[data-testid="mc-create-summary"]',
      '[data-testid="mc-create-tags"]',
    ];
    for (const selector of selectors) {
      const input = container.querySelector(selector) as HTMLInputElement | null;
      if (!input) throw new Error(`Missing input: ${selector}`);

      await act(async () => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      });

      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      await act(async () => {
        input.dispatchEvent(enter);
      });

      expect(enter.defaultPrevented).toBe(true);
    }
  });
});
