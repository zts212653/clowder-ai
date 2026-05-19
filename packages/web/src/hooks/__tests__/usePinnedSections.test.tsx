import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePinnedSections } from '@/hooks/usePinnedSections';

const STORAGE_KEY = 'cat-cafe:pinned-settings-sections';

type PinnedSectionsState = ReturnType<typeof usePinnedSections>;

describe('usePinnedSections', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: PinnedSectionsState | null;

  function Probe() {
    latest = usePinnedSections();
    return null;
  }

  beforeEach(() => {
    localStorage.clear();
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    localStorage.clear();
  });

  function renderHook() {
    React.act(() => {
      root.render(<Probe />);
    });
    if (!latest) throw new Error('usePinnedSections probe did not render');
    return latest;
  }

  it('ignores non-array localStorage payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: true }));

    const state = renderHook();

    expect(state.pinned).toEqual([]);
    expect(() => state.isPinned('accounts')).not.toThrow();
    expect(state.isPinned('accounts')).toBe(false);
  });

  it('ignores string localStorage payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('accounts'));

    const state = renderHook();

    expect(state.pinned).toEqual([]);
    expect(() => state.isPinned('accounts')).not.toThrow();
    expect(state.isPinned('accounts')).toBe(false);
  });

  it('filters non-string entries from array payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['accounts', null, 42, 'skills']));

    const state = renderHook();

    expect(state.pinned).toEqual(['accounts', 'skills']);
    expect(state.isPinned('accounts')).toBe(true);
    expect(state.isPinned('skills')).toBe(true);
  });
});
