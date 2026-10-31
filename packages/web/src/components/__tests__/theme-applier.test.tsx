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

/* What is in the room (hooks/useActualColours is covered on its own): a test sets it, then renders. */
let mockActual: import('@/lib/readable-name-plate').ActualColours | undefined;
vi.mock('@/hooks/useActualColours', () => ({ useActualColours: () => mockActual }));

const { ThemeApplier } = await import('../ThemeApplier');
const { buildCSS } = await import('../dev/oklch-tuner-css');
const { getActiveTheme, useThemeStore } = await import('@/stores/themeStore');

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

  describe('resolves the theme against what is in the room (F322 B, Opus 5.5 3619)', () => {
    const noHc = { on: false, hue: 0, chroma: 0 };
    const regular = {
      cats: [
        { h: 250, c: 0.12 },
        { h: 25, c: 0.15 },
        { h: 145, c: 0.1 },
      ],
      human: { h: 58, c: 0.04 },
    };
    const injected = () => document.getElementById('oklch-tuner-override')?.textContent ?? '';
    const expected = (actual: typeof mockActual) =>
      buildCSS(getActiveTheme(useThemeStore.getState()).params, noHc, actual);

    afterEach(() => {
      mockActual = undefined;
    });

    it('injects what buildCSS gives for the cats that exist, and again when the catalogue changes', () => {
      mockActual = regular;
      act(() => {
        root.render(React.createElement(ThemeApplier));
      });
      expect(injected()).toBe(expected(regular));

      const withExtreme = { ...regular, cats: [...regular.cats, { h: 328, c: 0.32 }] };
      mockActual = withExtreme;
      act(() => {
        root.render(React.createElement(ThemeApplier));
      });
      expect(injected()).toBe(expected(withExtreme));
      expect(expected(withExtreme)).not.toBe(expected(regular));
    });

    it('falls back to the swept range only while nothing is known about the room', () => {
      mockActual = undefined;
      act(() => {
        root.render(React.createElement(ThemeApplier));
      });

      expect(injected()).toBe(expected(undefined));
    });
  });

  it('syncs next-themes when it differs from the active base', () => {
    mockTheme = 'dark';

    act(() => {
      root.render(React.createElement(ThemeApplier));
    });

    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });
});
