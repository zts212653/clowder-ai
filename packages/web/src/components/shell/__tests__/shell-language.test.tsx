import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHELL_LANGUAGE,
  parseShellLanguage,
  readShellLanguage,
  SHELL_LANGUAGE_STORAGE_KEY,
  useShellLanguage,
  writeShellLanguage,
} from '../shell-language';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell-presentation';

function Probe() {
  const language = useShellLanguage();
  return <output data-testid="language">{language}</output>;
}

describe('shell language preference (F322 AC-B7)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const shown = () => container.querySelector('[data-testid="language"]')?.textContent;
  const mount = () => act(() => root.render(<Probe />));

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('only knows 中文 and English, and says nothing for anything else', () => {
    expect(parseShellLanguage('zh')).toBe('zh');
    expect(parseShellLanguage('en')).toBe('en');
    for (const bad of ['', 'EN', 'zh-CN', 'fr', null, undefined, 1, {}]) expect(parseShellLanguage(bad)).toBeNull();
  });

  it('is 中文 until someone chooses, and an unreadable stored value does not change that', () => {
    expect(DEFAULT_SHELL_LANGUAGE).toBe('zh');
    expect(readShellLanguage()).toBe('zh');
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'klingon');
    expect(readShellLanguage()).toBe('zh');
  });

  it('keeps the choice with no expiry: the stored value is the bare language, nothing that can lapse', () => {
    writeShellLanguage('en');
    expect(window.localStorage.getItem(SHELL_LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(readShellLanguage()).toBe('en');
  });

  it('survives a reload: a freshly mounted reader gets what was written', () => {
    writeShellLanguage('en');
    mount();
    expect(shown()).toBe('en');
  });

  it('flips every mounted reader in this tab without anyone remounting', () => {
    mount();
    const output = container.querySelector('output');
    expect(shown()).toBe('zh');
    act(() => writeShellLanguage('en'));
    expect(shown()).toBe('en');
    act(() => writeShellLanguage('zh'));
    expect(shown()).toBe('zh');
    expect(container.querySelector('output')).toBe(output);
  });

  it('follows a change made in another tab', () => {
    mount();
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_LANGUAGE_STORAGE_KEY, newValue: 'en' }));
    });
    expect(shown()).toBe('en');
  });

  it('ignores storage changes that are about something else', () => {
    mount();
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'some-other-key', newValue: 'en' }));
    });
    expect(shown()).toBe('zh');
  });

  it('is independent of the shell presentation switch: neither write touches the other key', () => {
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'classic');
    writeShellLanguage('en');
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBe('classic');
    expect(SHELL_LANGUAGE_STORAGE_KEY).not.toBe(SHELL_PRESENTATION_STORAGE_KEY);
  });

  /** Storage that holds what is there but refuses every write (private mode, quota). */
  function refusingWrites<T>(run: () => T): T {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    try {
      return run();
    } finally {
      Storage.prototype.setItem = original;
    }
  }

  it.each([
    ['zh', 'en'],
    ['en', 'zh'],
  ] as const)('a choice storage refused wins over the value already stored (stored %s, chose %s), in both directions', (stored, chosen) => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, stored);
    mount();
    expect(shown()).toBe(stored);
    refusingWrites(() => act(() => writeShellLanguage(chosen)));
    expect(window.localStorage.getItem(SHELL_LANGUAGE_STORAGE_KEY)).toBe(stored);
    expect(shown()).toBe(chosen);
    expect(readShellLanguage()).toBe(chosen);
  });

  it('lets a later write that reaches storage replace a choice storage refused', () => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'zh');
    mount();
    refusingWrites(() => act(() => writeShellLanguage('en')));
    act(() => writeShellLanguage('zh'));
    expect(shown()).toBe('zh');
    expect(window.localStorage.getItem(SHELL_LANGUAGE_STORAGE_KEY)).toBe('zh');
    // and nothing is left over from the refused choice
    act(() => {
      window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_LANGUAGE_STORAGE_KEY, newValue: 'en' }));
    });
    expect(shown()).toBe('en');
  });

  it('gives way to a new decision from another tab: that tab chose after this tab could not store its own', () => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
    mount();
    refusingWrites(() => act(() => writeShellLanguage('zh')));
    expect(shown()).toBe('zh');
    act(() => {
      window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_LANGUAGE_STORAGE_KEY, newValue: 'en' }));
    });
    expect(shown()).toBe('en');
  });

  it('follows another tab clearing all storage: a storage event with no key means everything may have changed', () => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
    mount();
    expect(shown()).toBe('en');
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(shown()).toBe('zh');
  });

  it('also drops a refused choice when another tab clears all storage', () => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'zh');
    mount();
    refusingWrites(() => act(() => writeShellLanguage('en')));
    expect(shown()).toBe('en');
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(shown()).toBe('zh');
  });

  it.each([
    ['another tab clears all storage', () => ({ key: null as string | null }), () => window.localStorage.clear(), 'zh'],
    [
      'another tab stores its own choice',
      () => ({ key: SHELL_LANGUAGE_STORAGE_KEY, newValue: 'zh' }),
      () => window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'zh'),
      'zh',
    ],
  ] as const)('a refused choice does not survive a newer decision (%s) that arrives while no reader is mounted', (_label, eventInit, applyRemote, expected) => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'zh');
    mount();
    refusingWrites(() => act(() => writeShellLanguage('en')));
    expect(shown()).toBe('en');

    // Switching away from v2 removes the only reader — and with it every subscription.
    act(() => root.render(null));
    applyRemote();
    window.dispatchEvent(new StorageEvent('storage', eventInit()));

    mount();
    expect(shown()).toBe(expected);
    expect(readShellLanguage()).toBe(expected);
  });

  it('still remembers a refused choice across an unmount and a remount when nothing newer has happened', () => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'zh');
    mount();
    refusingWrites(() => act(() => writeShellLanguage('en')));
    act(() => root.render(null));
    mount();
    expect(shown()).toBe('en');
  });

  it('still flips this tab when storage refuses the write (private mode / quota), and lets a later write take over', () => {
    mount();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    try {
      act(() => writeShellLanguage('en'));
    } finally {
      Storage.prototype.setItem = original;
    }
    // Nothing was stored, so a reload would forget it — but the tab the user is looking at must not lie about the click.
    expect(window.localStorage.getItem(SHELL_LANGUAGE_STORAGE_KEY)).toBeNull();
    expect(shown()).toBe('en');
    act(() => writeShellLanguage('zh'));
    expect(window.localStorage.getItem(SHELL_LANGUAGE_STORAGE_KEY)).toBe('zh');
    expect(shown()).toBe('zh');
  });
});
