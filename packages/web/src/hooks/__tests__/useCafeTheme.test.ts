/**
 * F056 Phase D: useCafeTheme hook tests
 * TDD — tests written before implementation.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next-themes useTheme
const mockSetTheme = vi.fn();
let mockTheme = 'light';
let mockResolvedTheme = 'light';

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: mockTheme,
    resolvedTheme: mockResolvedTheme,
    setTheme: mockSetTheme,
  }),
}));

const { useCafeTheme } = await import('../useCafeTheme');

// Minimal hook renderer — captures hook return value
let captured: ReturnType<typeof useCafeTheme> | null = null;

function HookHost() {
  captured = useCafeTheme();
  return null;
}

let root: Root;
let container: HTMLDivElement;

describe('useCafeTheme (F056 Phase D)', () => {
  beforeEach(() => {
    mockTheme = 'light';
    mockResolvedTheme = 'light';
    mockSetTheme.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(HookHost));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    captured = null;
  });

  it('returns light as default theme', () => {
    expect(captured?.theme).toBe('light');
    expect(captured?.resolvedTheme).toBe('light');
  });

  it('toggleTheme switches light → dark', () => {
    captured?.toggleTheme();
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  it('toggleTheme switches dark → light', () => {
    mockResolvedTheme = 'dark';
    act(() => {
      root.render(React.createElement(HookHost));
    });
    captured?.toggleTheme();
    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });

  it('setTheme("system") delegates to next-themes', () => {
    captured?.setTheme('system');
    expect(mockSetTheme).toHaveBeenCalledWith('system');
  });

  it('handles system theme with correct resolvedTheme', () => {
    mockTheme = 'system';
    mockResolvedTheme = 'dark';
    act(() => {
      root.render(React.createElement(HookHost));
    });
    expect(captured?.theme).toBe('system');
    expect(captured?.resolvedTheme).toBe('dark');
  });
});
