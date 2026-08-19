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
    expect(container.querySelector('[data-testid="composer-add-menu"]')).toBeNull();

    const plusBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
    act(() => {
      plusBtn.click();
    });

    expect(container.textContent).toContain('引用 Thread 或文件');
    expect(container.textContent).toContain('上传附件');
    expect(container.textContent).toContain('悄悄话');
    expect(container.textContent).toContain('游戏');
  });

  it('collapses the secondary menu when + is clicked again', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
    // Open
    act(() => {
      plusBtn.click();
    });
    expect(container.querySelector('[data-testid="composer-add-menu"]')).toBeTruthy();
    // Close
    act(() => {
      plusBtn.click();
    });
    expect(container.querySelector('[data-testid="composer-add-menu"]')).toBeNull();
  });

  it('collapses on a real pointer click without the outside-click handler reopening it', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
    act(() => plusBtn.click());
    expect(container.querySelector('[data-testid="composer-add-menu"]')).toBeTruthy();

    act(() => {
      plusBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      plusBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="composer-add-menu"]')).toBeNull();
  });

  it('+ button has rotate-45 class when its menu is open', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
    expect(plusBtn.className).not.toContain('rotate-45');
    act(() => {
      plusBtn.click();
    });
    expect(plusBtn.className).toContain('rotate-45');
  });
});

describe('ChatInput textarea auto-grow', () => {
  it('starts with rows=1', () => {
    render();
    const ta = container.querySelector('textarea')!;
    expect(ta.getAttribute('rows')).toBe('1');
  });

  it('auto-grow uses matchMedia guard (no crash in test env)', () => {
    // matchMedia may not be defined in jsdom — the guard prevents crash
    render();
    const ta = container.querySelector('textarea')!;
    // Just verify textarea renders without errors
    expect(ta).toBeTruthy();
  });

  it('auto-grow respects mobile max height when matchMedia is available', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width'), // mobile
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render();
    const ta = container.querySelector('textarea')!;
    // Simulate typing to trigger auto-grow effect
    act(() => {
      Object.defineProperty(ta, 'scrollHeight', { value: 200, writable: true });
      ta.value = 'line1\nline2\nline3\nline4\nline5\nline6';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // On mobile, max height is 120px
    const height = parseInt(ta.style.height, 10);
    expect(height).toBeLessThanOrEqual(120);
  });
});

describe('ChatInput composer layout', () => {
  it('vertically centers the right-side controls with the textarea', () => {
    render();

    const row = container.querySelector('[data-testid="chat-input-composer-row"]');
    expect(row?.className).toContain('items-center');
    expect(row?.className).not.toContain('items-end');
  });

  it('keeps the active invocation stop affordance visible while preserving hover and keyboard focus styling', () => {
    render({ hasActiveInvocation: true });

    const stopButton = Array.from(container.querySelectorAll('button[aria-label="Stop generation"]')).find((button) =>
      button.className.includes('bg-conn-red-text'),
    ) as HTMLButtonElement | undefined;
    expect(stopButton).toBeTruthy();
    expect(stopButton?.disabled).toBe(true);
    expect(stopButton?.className).not.toContain('opacity-0');
    expect(stopButton?.className).toContain('bg-conn-red-text');
    expect(stopButton?.className).toContain('hover:bg-conn-red-hover');
    expect(stopButton?.className).toContain('focus-visible:ring-2');
  });
});
