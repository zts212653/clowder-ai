import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalNav } from '@/components/signals/SignalNav';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));

describe('SignalNav', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders back link and tab links with Chinese labels', async () => {
    await act(async () => {
      root.render(React.createElement(SignalNav, { active: 'signals' }));
    });

    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/signals', '/signals/sources']);
    expect(links.map((link) => link.textContent)).toEqual(['收件箱', '信号源']);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
  });
});
