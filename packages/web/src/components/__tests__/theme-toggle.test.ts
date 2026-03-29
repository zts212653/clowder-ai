/**
 * F056 Phase D: ThemeToggle component tests
 * TDD — tests written before implementation.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockToggleTheme = vi.fn();
let mockResolvedTheme = 'light';

vi.mock('@/hooks/useCafeTheme', () => ({
  useCafeTheme: () => ({
    theme: mockResolvedTheme === 'light' ? 'light' : 'dark',
    resolvedTheme: mockResolvedTheme as 'light' | 'dark',
    setTheme: vi.fn(),
    toggleTheme: mockToggleTheme,
  }),
}));

const { ThemeToggle } = await import('../ThemeToggle');

let root: Root;
let container: HTMLDivElement;

describe('ThemeToggle (F056 Phase D)', () => {
  beforeEach(() => {
    mockResolvedTheme = 'light';
    mockToggleTheme.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(ThemeToggle));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders a toggle button', () => {
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
  });

  it('shows sun icon in light mode (to switch to dark)', () => {
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('Switch to dark mode');
  });

  it('shows moon icon in dark mode (to switch to light)', () => {
    mockResolvedTheme = 'dark';
    act(() => {
      root.render(React.createElement(ThemeToggle));
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('Switch to light mode');
  });

  it('calls toggleTheme on click', () => {
    const button = container.querySelector('button');
    act(() => {
      button?.click();
    });
    expect(mockToggleTheme).toHaveBeenCalledOnce();
  });
});
