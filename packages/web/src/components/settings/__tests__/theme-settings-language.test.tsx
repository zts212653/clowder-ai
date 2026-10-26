import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const themes = vi.hoisted(() => ({
  state: {
    themes: [
      { id: 'light', name: 'Light', base: 'light', builtIn: true },
      { id: 'dark', name: 'Dark', base: 'dark', builtIn: true },
    ] as Array<{ id: string; name: string; base: string; builtIn: boolean }>,
    activeId: 'light',
    setActive: vi.fn(),
    deleteCustom: vi.fn(),
    createCustom: vi.fn(() => 'custom-1'),
  },
}));
const tuner = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('@/stores/themeStore', () => ({ useThemeStore: () => themes.state }));
vi.mock('../../dev/OklchTuner', () => ({
  OklchTuner: function Tuner() {
    useEffect(() => {
      tuner.mounts += 1;
      return () => {
        tuner.unmounts += 1;
      };
    }, []);
    return <div data-testid="tuner" />;
  },
}));

import { readShellLanguage, SHELL_LANGUAGE_STORAGE_KEY, writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { ThemeSettingsPanel } from '../ThemeSettingsPanel';

describe('F322 界面语言 on the 主题 page', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = () => act(() => root.render(<ThemeSettingsPanel />));
  const click = (selector: string) => act(() => host.querySelector<HTMLElement>(selector)?.click());
  const text = (selector: string) => host.querySelector(selector)?.textContent ?? null;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    tuner.mounts = 0;
    tuner.unmounts = 0;
    themes.state.themes = [
      { id: 'light', name: 'Light', base: 'light', builtIn: true },
      { id: 'dark', name: 'Dark', base: 'dark', builtIn: true },
    ];
    themes.state.activeId = 'light';
    window.localStorage.removeItem(SHELL_LANGUAGE_STORAGE_KEY);
    writeShellPresentation('v2');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.localStorage.removeItem(SHELL_LANGUAGE_STORAGE_KEY);
    writeShellPresentation('classic');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('is one section between 界面版本 and 配色, a labelled two-option radio group, Chinese by default', () => {
    render();
    const headings = ['#shell-presentation-heading', '#shell-language-heading', '#theme-list-heading'].map((selector) =>
      host.querySelector(selector),
    );
    expect(headings.map((heading) => heading?.textContent)).toEqual(['界面版本', '界面语言', '配色']);
    for (let index = 1; index < headings.length; index++) {
      const before = headings[index - 1] as Element;
      const after = headings[index] as Element;
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const group = host.querySelector('[role="radiogroup"][aria-labelledby="shell-language-heading"]');
    expect(group?.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="shell-language-zh"]')?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[data-testid="shell-language-en"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('writes each option in its own language, with a gloss only on the line that is not yours, set off by a separator', () => {
    render();
    expect(text('[data-testid="shell-language-zh"]')).toBe('中文（简体）');
    expect(text('[data-testid="shell-language-en"]')).toBe('English · 英文');
    click('[data-testid="shell-language-en"]');
    expect(text('[data-testid="shell-language-zh"]')).toBe('中文（简体） · Chinese (Simplified)');
    expect(text('[data-testid="shell-language-en"]')).toBe('English');
  });

  it('marks the language of each fragment of an option, so a screen reader pronounces each part in its own language', () => {
    const parts = (id: string) =>
      [...host.querySelectorAll(`[data-testid="shell-language-${id}"] [lang]`)].map((node) => [
        node.getAttribute('lang'),
        node.textContent,
      ]);
    render();
    expect(parts('zh')).toEqual([['zh-CN', '中文（简体）']]);
    expect(parts('en')).toEqual([
      ['en', 'English'],
      ['zh-CN', ' · 英文'],
    ]);
    click('[data-testid="shell-language-en"]');
    expect(parts('zh')).toEqual([
      ['zh-CN', '中文（简体）'],
      ['en', ' · Chinese (Simplified)'],
    ]);
    expect(parts('en')).toEqual([['en', 'English']]);
  });

  it('applies at once and persists the bare language: no Save control, no reload, nothing that can lapse', () => {
    render();
    const controls = () => [...host.querySelectorAll('button')].map((button) => button.textContent ?? '');
    expect(controls().some((label) => /保存|^Save$/i.test(label))).toBe(false);
    click('[data-testid="shell-language-en"]');
    expect(readShellLanguage()).toBe('en');
    expect(window.localStorage.getItem(SHELL_LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(host.querySelector('[data-testid="shell-language-en"]')?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[data-testid="shell-language-zh"]')?.getAttribute('aria-checked')).toBe('false');
    expect(controls().some((label) => /保存|^Save$/i.test(label))).toBe(false);
    click('[data-testid="shell-language-zh"]');
    expect(window.localStorage.getItem(SHELL_LANGUAGE_STORAGE_KEY)).toBe('zh');
  });

  it("puts the page's own words in English, the stored theme names left as they are (the colour tuner it opens is shared with classic and is not translated)", () => {
    themes.state.themes = [...themes.state.themes, { id: 'c1', name: 'My dusk', base: 'light', builtIn: false }];
    render();
    click('[data-testid="shell-language-en"]');
    expect(text('[data-testid="theme-settings-panel"] h2')).toBe('Theme');
    expect(host.textContent).toContain(
      'Interface version, language and colors are saved in this browser. Reply display follows your account.',
    );
    expect(text('#shell-presentation-heading')).toBe('Interface version');
    expect(text('[data-testid="shell-presentation-v2"]')).toContain('New interface');
    expect(text('[data-testid="shell-presentation-classic"]')).toContain('Classic interface');
    expect(text('#shell-language-heading')).toBe('Language');
    expect(text('#theme-list-heading')).toBe('Colors');
    expect(text('[data-testid="theme-light"]')).toBe('LightIn use');
    expect(host.querySelector('button[aria-label="Edit Dark"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Delete My dusk"]')).not.toBeNull();
    expect(text('[data-testid="theme-c1"]')).toBe('My dusk');
    expect(host.textContent).toContain('New theme');
    // nothing Chinese is left on the page except the option that names the Chinese language in Chinese
    const leftover = (host.textContent ?? '').replace('中文（简体）', '').match(/[\u3400-\u9fff]/gu) ?? [];
    expect(leftover).toEqual([]);
  });

  it('says the classic interface is not affected, in both languages', () => {
    render();
    expect(host.textContent).toContain('经典界面不受此设置影响');
    click('[data-testid="shell-language-en"]');
    expect(host.textContent).toContain('This setting does not affect the classic interface.');
  });

  it('a new custom theme is named in the language you are reading', () => {
    render();
    click('[data-testid="theme-create"]');
    expect(themes.state.createCustom).toHaveBeenLastCalledWith('自定义 1', 'light');
    click('[data-testid="shell-language-en"]');
    click('[data-testid="theme-create"]');
    expect(themes.state.createCustom).toHaveBeenLastCalledWith('Custom 1', 'light');
  });

  it('flips the words in place: an open tuner is neither unmounted nor re-created, the same nodes stay', async () => {
    render();
    click('button[aria-label="编辑 Dark"]');
    await vi.waitFor(() => expect(host.querySelector('[data-testid="tuner"]')).not.toBeNull());
    const tunerNode = host.querySelector('[data-testid="tuner"]');
    const panel = host.querySelector('[data-testid="theme-settings-panel"]');
    const languageButton = host.querySelector('[data-testid="shell-language-en"]');
    expect(tuner.mounts).toBe(1);

    click('[data-testid="shell-language-en"]');
    click('[data-testid="shell-language-zh"]');
    click('[data-testid="shell-language-en"]');

    expect(tuner.mounts).toBe(1);
    expect(tuner.unmounts).toBe(0);
    expect(host.querySelector('[data-testid="tuner"]')).toBe(tunerNode);
    expect(host.querySelector('[data-testid="theme-settings-panel"]')).toBe(panel);
    expect(host.querySelector('[data-testid="shell-language-en"]')).toBe(languageButton);
  });

  it('is the same preference every v2 surface reads: another tab choosing a language changes this page too', () => {
    render();
    act(() => {
      window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_LANGUAGE_STORAGE_KEY, newValue: 'en' }));
    });
    expect(text('#shell-language-heading')).toBe('Language');
    expect(host.querySelector('[data-testid="shell-language-en"]')?.getAttribute('aria-checked')).toBe('true');
    // and the control writes through the one writer, so it never keeps a copy of its own
    act(() => writeShellLanguage('zh'));
    expect(text('#shell-language-heading')).toBe('界面语言');
  });
});
