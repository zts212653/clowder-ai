import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';

vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/components/AttachmentPreview', () => ({ AttachmentPreview: () => null }));
vi.mock('@/utils/compressImage', () => ({
  compressImage: (f: File) => Promise.resolve(f),
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const defaults = { onSend: vi.fn(), disabled: false };
  act(() => {
    root.render(React.createElement(ChatInput, { ...defaults, ...props }));
  });
  return defaults;
}

describe('ChatInput progressive add menu', () => {
  it('shows one stable + entry at every width', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="添加"]');
    expect(plusBtn).toBeTruthy();
    expect(plusBtn?.className).not.toContain('md:hidden');
    expect(container.querySelectorAll('button[aria-label="添加"]')).toHaveLength(1);
  });

  it('reveals secondary actions only after + is clicked', () => {
    render();
    expect(document.querySelector('[data-testid="composer-add-menu"]')).toBeNull();

    const plusBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
    act(() => {
      plusBtn.click();
    });

    const menu = document.querySelector('[data-testid="composer-add-menu"]');
    expect(menu?.textContent).toContain('引用 Thread 或文件');
    expect(menu?.textContent).toContain('上传附件');
    expect(menu?.textContent).toContain('悄悄话');
    expect(menu?.textContent).not.toContain('游戏');
  });

  it('collapses the secondary menu when + is clicked again', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
    // Open
    act(() => {
      plusBtn.click();
    });
    expect(document.querySelector('[data-testid="composer-add-menu"]')).toBeTruthy();
    // Close
    act(() => {
      plusBtn.click();
    });
    expect(document.querySelector('[data-testid="composer-add-menu"]')).toBeNull();
  });

  it('collapses on a real pointer click without the outside-click handler reopening it', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
    act(() => plusBtn.click());
    expect(document.querySelector('[data-testid="composer-add-menu"]')).toBeTruthy();

    act(() => {
      plusBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      plusBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('[data-testid="composer-add-menu"]')).toBeNull();
  });
});

describe('ChatInput composer layout', () => {
  it('keeps the active invocation stop affordance visible while preserving hover and keyboard focus styling', () => {
    render({ hasActiveInvocation: true });

    const stopButtons = container.querySelectorAll('button[aria-label="Stop generation"]');
    expect(stopButtons).toHaveLength(1);
    const stopButton = stopButtons[0] as HTMLButtonElement;
    expect(stopButton).toBeTruthy();
    expect(stopButton?.disabled).toBe(true);
    expect(stopButton?.className).not.toContain('opacity-0');
    expect(stopButton?.className).toContain('hover:bg-conn-red-hover');
    expect(stopButton?.querySelector('svg rect')).not.toBeNull();
    expect(stopButton?.title).toBe('正在确认可停止的运行状态');
    expect(stopButton?.className).toContain('focus-visible:ring-2');
  });
});
