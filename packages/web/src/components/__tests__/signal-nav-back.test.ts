import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next/link as plain <a>
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [k: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

// Mock chatStore
const mockStoreState = { currentThreadId: 'default' };
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { SignalNav } from '@/components/signals/SignalNav';

describe('SignalNav back button', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('preserves ?from= across Signals and Sources nav links', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?from=thread_abc' },
      writable: true,
      configurable: true,
    });

    React.act(() => {
      root.render(React.createElement(SignalNav, { active: 'signals' }));
    });

    const links = Array.from(container.querySelectorAll('a'));
    const signalsLink = links.find((a) => a.textContent === '收件箱');
    const sourcesLink = links.find((a) => a.textContent === '信号源');

    expect(signalsLink?.getAttribute('href')).toContain('?from=thread_abc');
    expect(sourcesLink?.getAttribute('href')).toContain('?from=thread_abc');

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '' },
      writable: true,
      configurable: true,
    });
  });
});
