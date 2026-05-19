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

  it('renders "返回线程" back button with Mission Hub style', () => {
    React.act(() => {
      root.render(React.createElement(SignalNav, { active: 'signals' }));
    });

    const backLink = container.querySelector('[data-testid="signal-back-to-chat"]') as HTMLAnchorElement;
    expect(backLink).toBeTruthy();
    expect(backLink.textContent).toContain('返回线程');
  });

  it('back button links to / when no referrer thread', () => {
    mockStoreState.currentThreadId = 'default';

    React.act(() => {
      root.render(React.createElement(SignalNav, { active: 'signals' }));
    });

    const backLink = container.querySelector('[data-testid="signal-back-to-chat"]') as HTMLAnchorElement;
    expect(backLink.getAttribute('href')).toBe('/');
  });

  it('back button links to referrer thread from ?from= param', () => {
    // Simulate ?from=thread_abc in URL
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?from=thread_abc' },
      writable: true,
      configurable: true,
    });

    React.act(() => {
      root.render(React.createElement(SignalNav, { active: 'signals' }));
    });

    const backLink = container.querySelector('[data-testid="signal-back-to-chat"]') as HTMLAnchorElement;
    expect(backLink.getAttribute('href')).toBe('/thread/thread_abc');

    // Restore
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '' },
      writable: true,
      configurable: true,
    });
  });

  it('back button falls back to store currentThreadId when no ?from= param', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '' },
      writable: true,
      configurable: true,
    });
    mockStoreState.currentThreadId = 'thread_xyz';

    React.act(() => {
      root.render(React.createElement(SignalNav, { active: 'signals' }));
    });

    const backLink = container.querySelector('[data-testid="signal-back-to-chat"]') as HTMLAnchorElement;
    expect(backLink.getAttribute('href')).toBe('/thread/thread_xyz');

    // Reset
    mockStoreState.currentThreadId = 'default';
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
    const signalsLink = links.find((a) => a.textContent === 'Signals');
    const sourcesLink = links.find((a) => a.textContent === 'Sources');

    expect(signalsLink?.getAttribute('href')).toContain('?from=thread_abc');
    expect(sourcesLink?.getAttribute('href')).toContain('?from=thread_abc');

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '' },
      writable: true,
      configurable: true,
    });
  });
});
