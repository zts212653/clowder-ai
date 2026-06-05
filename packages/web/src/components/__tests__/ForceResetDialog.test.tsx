import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForceResetDialog } from '../ForceResetDialog';

/**
 * F220 Phase 3 — force-reset 确认弹窗（AC-3.2）。
 * 真相源：docs/features/F220-a2a-collab-reliability.md §设计稿 / assets/F220/force-reset-mock.html
 * 点击不立即执行——先弹窗讲清 做什么/保留什么/何时用，确认才 onConfirm。
 */
describe('ForceResetDialog', () => {
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
    vi.clearAllMocks();
  });

  it('renders nothing when closed', () => {
    act(() => {
      root.render(React.createElement(ForceResetDialog, { open: false, onCancel: () => {}, onConfirm: () => {} }));
    });
    expect(container.textContent).toBe('');
  });

  it('renders title + three explanation rows (做什么/保留什么/何时用) when open', () => {
    act(() => {
      root.render(React.createElement(ForceResetDialog, { open: true, onCancel: () => {}, onConfirm: () => {} }));
    });
    expect(container.textContent).toContain('强制重置这个对话');
    expect(container.textContent).toContain('会做什么');
    expect(container.textContent).toContain('会保留什么');
    expect(container.textContent).toContain('何时用');
  });

  it('calls onCancel and onConfirm when respective buttons are clicked', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    act(() => {
      root.render(React.createElement(ForceResetDialog, { open: true, onCancel, onConfirm }));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const cancelBtn = buttons.find((b) => b.textContent?.includes('取消')) ?? null;
    const confirmBtn = buttons.find((b) => b.textContent?.includes('强制重置')) ?? null;
    expect(cancelBtn).not.toBeNull();
    expect(confirmBtn).not.toBeNull();

    await act(async () => {
      cancelBtn?.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      confirmBtn?.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables confirm button while busy (prevents double force-reset)', () => {
    act(() => {
      root.render(
        React.createElement(ForceResetDialog, { open: true, busy: true, onCancel: () => {}, onConfirm: () => {} }),
      );
    });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('强制重置'),
    ) as HTMLButtonElement | undefined;
    expect(confirmBtn?.disabled).toBe(true);
  });
});
