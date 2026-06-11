import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockSetTheme = vi.fn();
let mockTheme: 'light' | 'dark' | 'system' = 'light';

vi.mock('@/hooks/useCafeTheme', () => ({
  useCafeTheme: () => ({
    theme: mockTheme,
    resolvedTheme: mockTheme === 'dark' ? 'dark' : 'light',
    setTheme: mockSetTheme,
    toggleTheme: vi.fn(),
  }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: false })),
}));

const { ThemeApplier } = await import('../ThemeApplier');

let root: Root;
let container: HTMLDivElement;

describe('ThemeApplier', () => {
  beforeEach(() => {
    mockTheme = 'light';
    mockSetTheme.mockClear();
    localStorage.setItem('cat-cafe:themes', JSON.stringify({ version: 'test', activeId: 'light', custom: [] }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('does not rewrite next-themes when it already matches the active base', () => {
    act(() => {
      root.render(React.createElement(ThemeApplier));
    });

    expect(mockSetTheme).not.toHaveBeenCalled();
  });

  it('syncs next-themes when it differs from the active base', () => {
    mockTheme = 'dark';

    act(() => {
      root.render(React.createElement(ThemeApplier));
    });

    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });
});
