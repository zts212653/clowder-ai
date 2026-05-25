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

describe('ChatInput mobile toolbar', () => {
  it('shows mobile + button (hidden on md+)', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="展开工具栏"]');
    expect(plusBtn).toBeTruthy();
    // Button should have md:hidden class
    expect(plusBtn?.className).toContain('md:hidden');
  });

  it('expands toolbar on + click and shows attach/whisper buttons', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="展开工具栏"]') as HTMLButtonElement;
    act(() => {
      plusBtn.click();
    });
    // MobileInputToolbar should now be visible
    expect(container.textContent).toContain('附件');
    expect(container.textContent).toContain('悄悄话');
  });

  it('collapses toolbar when + is clicked again (rotate-45 toggle)', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="展开工具栏"]') as HTMLButtonElement;
    // Open
    act(() => {
      plusBtn.click();
    });
    expect(container.textContent).toContain('附件');
    // Close
    act(() => {
      plusBtn.click();
    });
    // MobileInputToolbar should be gone
    expect(container.textContent).not.toContain('附件');
  });

  it('+ button has rotate-45 class when toolbar is open', () => {
    render();
    const plusBtn = container.querySelector('button[aria-label="展开工具栏"]') as HTMLButtonElement;
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
    render({ hasActiveInvocation: true, onStop: vi.fn() });

    const stopButton = container.querySelector('button[aria-label="Stop generation"]');
    expect(stopButton?.className).not.toContain('opacity-0');
    expect(stopButton?.className).toContain('bg-conn-red-text');
    expect(stopButton?.className).toContain('hover:bg-conn-red-hover');
    expect(stopButton?.className).toContain('focus-visible:ring-2');
  });
});
