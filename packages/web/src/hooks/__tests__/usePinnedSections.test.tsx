import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePinnedSections } from '@/hooks/usePinnedSections';

const STORAGE_KEY = 'cat-cafe:pinned-settings-sections';
const DESKTOP_SEED_KEY = 'cat-cafe:pinned-settings-sections:desktop-seeded';
const LEGACY_DEFAULTS_SEED_KEY = 'cat-cafe:pinned-settings-sections:defaults-seeded';
const SEEDED_DEFAULTS_KEY = 'cat-cafe:pinned-settings-sections:seeded-defaults';

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
    delete window.desktopBridge;
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    localStorage.clear();
    delete window.desktopBridge;
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

    expect(state.pinned).toEqual(['members', 'accounts']);
    expect(() => state.isPinned('accounts')).not.toThrow();
    expect(state.isPinned('accounts')).toBe(true);
  });

  it('ignores string localStorage payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('accounts'));

    const state = renderHook();

    expect(state.pinned).toEqual(['members', 'accounts']);
    expect(() => state.isPinned('accounts')).not.toThrow();
    expect(state.isPinned('accounts')).toBe(true);
  });

  it('filters non-string entries from array payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['accounts', null, 42, 'skills']));

    const state = renderHook();

    expect(state.pinned).toEqual(['accounts', 'skills', 'members']);
    expect(state.isPinned('accounts')).toBe(true);
    expect(state.isPinned('skills')).toBe(true);
  });

  it('seeds members and accounts once on the first browser mount', () => {
    const state = renderHook();

    expect(state.pinned).toEqual(['members', 'accounts']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(['members', 'accounts']);
    expect(JSON.parse(localStorage.getItem(SEEDED_DEFAULTS_KEY) ?? 'null')).toEqual(['members', 'accounts']);
    expect(localStorage.getItem(DESKTOP_SEED_KEY)).toBeNull();
  });

  it('uses the same persisted default pins on the first packaged-desktop mount', () => {
    Object.defineProperty(window, 'desktopBridge', { value: {}, configurable: true, writable: true });

    const state = renderHook();

    expect(state.pinned).toEqual(['members', 'accounts']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(['members', 'accounts']);
    expect(JSON.parse(localStorage.getItem(SEEDED_DEFAULTS_KEY) ?? 'null')).toEqual(['members', 'accounts']);
  });

  it('preserves existing pins while adding defaults on the first launch', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['skills', 'members']));

    const state = renderHook();

    expect(state.pinned).toEqual(['skills', 'members', 'accounts']);
  });

  it('does not restore a seeded default after capacity blocked the other default', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(['skills', 'mcp', 'plugins', 'marketplace', 'concierge', 'voice', 'system', 'members']),
    );

    let state = renderHook();

    expect(state.pinned).not.toContain('accounts');
    expect(JSON.parse(localStorage.getItem(SEEDED_DEFAULTS_KEY) ?? 'null')).toEqual(['members']);

    React.act(() => state.unpin('members'));
    React.act(() => root.render(null));
    state = renderHook();

    expect(state.pinned).not.toContain('members');
    expect(state.pinned).toContain('accounts');
  });

  it('seeds each default at most once when only one slot is initially available', () => {
    const customPins = ['skills', 'mcp', 'plugins', 'marketplace', 'concierge', 'voice', 'system'];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customPins));

    let state = renderHook();
    expect(state.pinned).toEqual([...customPins, 'members']);

    React.act(() => state.unpin('members'));
    React.act(() => root.render(null));
    state = renderHook();

    expect(state.pinned).toEqual([...customPins, 'accounts']);
    expect(JSON.parse(localStorage.getItem(SEEDED_DEFAULTS_KEY) ?? 'null')).toEqual(['members', 'accounts']);

    React.act(() => state.unpin('accounts'));
    React.act(() => root.render(null));
    state = renderHook();

    expect(state.pinned).toEqual(customPins);
  });

  it('respects an explicit unpin after the user manually pinned a pending default', () => {
    const customPins = ['skills', 'mcp', 'plugins', 'marketplace', 'concierge', 'voice', 'system'];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customPins));

    let state = renderHook();
    expect(state.pinned).toEqual([...customPins, 'members']);

    React.act(() => state.unpin('skills'));
    React.act(() => state.pin('accounts'));
    React.act(() => state.unpin('accounts'));
    React.act(() => root.render(null));
    state = renderHook();

    expect(state.pinned).not.toContain('accounts');
  });

  it('remembers a user unpin after the defaults have been seeded', () => {
    let state = renderHook();

    React.act(() => state.unpin('members'));
    expect(latest?.pinned).toEqual(['accounts']);

    React.act(() => root.render(null));
    state = renderHook();

    expect(state.pinned).toEqual(['accounts']);
    expect(JSON.parse(localStorage.getItem(SEEDED_DEFAULTS_KEY) ?? 'null')).toEqual(['members', 'accounts']);
  });

  it('honours the legacy desktop seed receipt without restoring a cancelled pin', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['accounts']));
    localStorage.setItem(DESKTOP_SEED_KEY, '1');

    const state = renderHook();

    expect(state.pinned).toEqual(['accounts']);
    expect(JSON.parse(localStorage.getItem(SEEDED_DEFAULTS_KEY) ?? 'null')).toEqual(['members', 'accounts']);
  });

  it('migrates the former shared complete receipt without restoring cancelled pins', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['members']));
    localStorage.setItem(LEGACY_DEFAULTS_SEED_KEY, '1');

    const state = renderHook();

    expect(state.pinned).toEqual(['members']);
    expect(JSON.parse(localStorage.getItem(SEEDED_DEFAULTS_KEY) ?? 'null')).toEqual(['members', 'accounts']);
  });

  it('prefers an existing per-item receipt over legacy complete receipts', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['members']));
    localStorage.setItem(SEEDED_DEFAULTS_KEY, JSON.stringify(['members']));
    localStorage.setItem(DESKTOP_SEED_KEY, '1');
    localStorage.setItem(LEGACY_DEFAULTS_SEED_KEY, '1');

    const state = renderHook();

    expect(state.pinned).toEqual(['members', 'accounts']);
    expect(JSON.parse(localStorage.getItem(SEEDED_DEFAULTS_KEY) ?? 'null')).toEqual(['members', 'accounts']);
  });
});
