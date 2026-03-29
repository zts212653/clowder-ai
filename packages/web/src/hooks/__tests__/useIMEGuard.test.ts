// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useIMEGuard } from '../useIMEGuard';

/** Minimal component that wires useIMEGuard to an input */
function TestInput({ onSubmit }: { onSubmit: () => void }) {
  const ime = useIMEGuard();
  return React.createElement('input', {
    onCompositionStart: ime.onCompositionStart,
    onCompositionEnd: ime.onCompositionEnd,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !ime.isComposing()) onSubmit();
    },
  });
}

describe('useIMEGuard', () => {
  function setup() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSubmit = vi.fn();

    act(() => {
      root.render(React.createElement(TestInput, { onSubmit }));
    });
    const input = container.querySelector('input')!;
    return { input, onSubmit, cleanup: () => root.unmount() };
  }

  it('allows Enter when not composing', () => {
    const { input, onSubmit, cleanup } = setup();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    cleanup();
  });

  it('blocks Enter during active composition (Firefox path)', () => {
    const { input, onSubmit, cleanup } = setup();
    act(() => {
      input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    act(() => {
      // Firefox: keydown fires with isComposing = true (but our guard uses the ref)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  it('blocks Enter in Chrome scenario: compositionend fires before keydown', () => {
    const { input, onSubmit, cleanup } = setup();
    // 1. Start composition
    act(() => {
      input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    // 2. Chrome: compositionend fires FIRST
    act(() => {
      input.dispatchEvent(new Event('compositionend', { bubbles: true }));
    });
    // 3. Chrome: keydown(Enter) fires AFTER compositionend, isComposing = false
    //    Without the rAF delay guard, this would incorrectly submit.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  it('allows Enter after rAF flushes post-compositionend', async () => {
    const { input, onSubmit, cleanup } = setup();
    act(() => {
      input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new Event('compositionend', { bubbles: true }));
    });
    // Wait for rAF to flush
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    cleanup();
  });

  it('rapid re-composition cancels pending rAF clear', () => {
    const { input, onSubmit, cleanup } = setup();
    act(() => {
      input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new Event('compositionend', { bubbles: true }));
    });
    // Immediately start new composition before rAF fires
    act(() => {
      input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    // Enter should still be blocked
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });
});
