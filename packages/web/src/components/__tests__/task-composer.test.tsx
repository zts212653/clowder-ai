import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('TaskComposer', () => {
  it('renders title input and submit button when open', async () => {
    const { TaskComposer } = await import('../TaskComposer');
    const html = renderToStaticMarkup(<TaskComposer threadId="t1" onClose={vi.fn()} />);
    expect(html).toContain('placeholder');
    expect(html).toContain('创建任务');
  });

  it('renders why textarea', async () => {
    const { TaskComposer } = await import('../TaskComposer');
    const html = renderToStaticMarkup(<TaskComposer threadId="t1" onClose={vi.fn()} />);
    expect(html).toContain('textarea');
  });

  it('renders cancel button', async () => {
    const { TaskComposer } = await import('../TaskComposer');
    const html = renderToStaticMarkup(<TaskComposer threadId="t1" onClose={vi.fn()} />);
    expect(html).toContain('取消');
  });

  describe('submit error handling (P2 fix)', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    });

    it('does not call onClose when fetch returns non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const onClose = vi.fn();

      const { TaskComposer } = await import('../TaskComposer');
      await act(async () => {
        root.render(<TaskComposer threadId="t1" onClose={onClose} />);
      });

      // Type a title to enable submit
      const input = container.querySelector('input[type="text"]') as HTMLInputElement;
      await act(async () => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        nativeInputValueSetter?.call(input, 'Test task');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Click submit
      const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '创建任务');
      expect(submitBtn).toBeTruthy();
      await act(async () => {
        submitBtn!.click();
      });

      // Wait for async fetch to settle
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      // onClose should NOT have been called on server error
      expect(onClose).not.toHaveBeenCalled();
      // Error message should be visible
      expect(container.textContent).toContain('创建失败');
    });

    it('calls onClose when fetch returns ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
      const onClose = vi.fn();

      const { TaskComposer } = await import('../TaskComposer');
      await act(async () => {
        root.render(<TaskComposer threadId="t1" onClose={onClose} />);
      });

      // Type a title
      const input = container.querySelector('input[type="text"]') as HTMLInputElement;
      await act(async () => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        nativeInputValueSetter?.call(input, 'Test task');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Click submit
      const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '创建任务');
      await act(async () => {
        submitBtn!.click();
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      // onClose SHOULD be called on success
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
