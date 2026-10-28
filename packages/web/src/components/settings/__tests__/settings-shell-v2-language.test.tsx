import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ search: '', push: vi.fn(), replace: vi.fn(), pathname: '/settings' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const chat = vi.hoisted(() => ({ setWorkspaceMode: vi.fn(), openTeamSubject: vi.fn() }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (state: typeof chat) => unknown) => select(chat),
}));

const pins = vi.hoisted(() => ({ pinned: [] as string[], pin: vi.fn(), unpin: vi.fn() }));
vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ ...pins, isPinned: (id: string) => pins.pinned.includes(id) }),
}));

vi.mock('../SettingsContent', () => ({
  SettingsContent: ({ section }: { section: string }) => <div data-testid="content" data-section={section} />,
}));
vi.mock('../ThemeSettingsPanel', () => ({ ThemeSettingsPanel: () => <div data-testid="theme-settings-panel" /> }));
vi.mock('../plugin-manager/plugin-manager-design-gate', () => ({ usesFixedPluginManagerLayout: () => false }));

import { SHELL_LANGUAGE_STORAGE_KEY, writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SettingsShell } from '../SettingsShell';
import { SETTINGS_IA } from '../settings-ia';

describe('F322 设置与管理 catalogue in both languages', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render(search: string) {
    nav.search = search;
    window.history.replaceState(null, '', search ? `/settings?${search}` : '/settings');
    act(() => root.render(<SettingsShell />));
  }
  const entryText = (id: string) => host.querySelector(`[data-testid="settings-entry-${id}"]`)?.textContent ?? null;
  // exact accessible-name match (an attribute selector cannot carry the quotes the English pin sentence has)
  const buttonNamed = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('button[aria-label]')].find((b) => b.getAttribute('aria-label') === name) ??
    null;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    pins.pinned = [];
    nav.pathname = '/settings';
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

  it('reads in Chinese by default, as it always did', () => {
    render('s=theme');
    expect(host.querySelector('h1')?.textContent).toBe('设置与管理');
    expect(host.querySelector('nav[aria-label="设置与管理"]')).not.toBeNull();
    expect(entryText('connect')).toBe('连接与扩展');
    expect(entryText('mission')).toBe('功能看板');
    expect(host.querySelector('button[aria-label="固定「主题」到窄栏"]')).not.toBeNull();
  });

  it('reads the approved English names with You before the eleven existing entries', () => {
    writeShellLanguage('en');
    render('s=theme');
    expect(host.querySelector('h1')?.textContent).toBe('Settings');
    expect(host.querySelector('nav[aria-label="Settings"]')).not.toBeNull();
    const entries = host.querySelectorAll('[data-testid^="settings-entry-"]');
    expect(entries).toHaveLength(12);
    expect(entries[0]?.getAttribute('data-testid')).toBe('settings-entry-you');
    expect(entryText('you')).toMatch(/You$/);
    expect(
      [
        'team',
        'schedule',
        'evolution',
        'eval',
        'connect',
        'system',
        'theme',
        'community',
        'starry',
        'mission',
        'signals',
      ].map(entryText),
    ).toEqual([
      'Cat team',
      'Scheduling',
      'Capability evolution',
      'Evaluation',
      'Integrations',
      'System',
      'Theme',
      'Community',
      'Cat Planet',
      'Mission Hub',
      'Signals',
    ]);
  });

  it('pin toggles say what they pin in the language of the page', () => {
    writeShellLanguage('en');
    render('s=theme');
    expect(buttonNamed('Pin "Theme" to the narrow rail')).not.toBeNull();
    act(() => buttonNamed('Pin "Cat team" to the narrow rail')?.click());
    expect(pins.pin).toHaveBeenLastCalledWith('dest:team');
    pins.pinned = ['dest:theme'];
    render('s=theme');
    expect(buttonNamed('Unpin "Theme" from the narrow rail')).not.toBeNull();
    expect(buttonNamed('从窄栏取消固定「主题」')).toBeNull(); // not the Chinese sentence in English mode
  });

  it('localizes the mobile navigation, team tabs and workspace action together', () => {
    writeShellLanguage('en');
    render('s=members');
    expect(host.querySelector('button[aria-controls="settings-mobile-navigation"]')?.textContent).toBe(
      'Settings navigation',
    );
    expect(host.querySelector('[data-testid="settings-tab-concierge"]')?.textContent).toBe('Cat Ball');
    expect(host.querySelector('[data-testid="settings-team-workspace"]')?.textContent).toBe(
      'Member capabilities & routing',
    );
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Cat team sections');
    act(() => buttonNamed('Pin "Member capabilities & routing" to the narrow rail')?.click());
    expect(pins.pin).toHaveBeenLastCalledWith('dest:team-workspace');
  });

  it('uses English for every known second-level menu, including its accessible names', () => {
    writeShellLanguage('en');
    for (const entry of SETTINGS_IA) {
      if (entry.destination.kind !== 'sections') continue;
      const section = entry.destination.items.find((item) => item.kind === 'section');
      if (!section || section.kind !== 'section') throw Error('missing section');
      render(`s=${section.sectionId}`);
      const menus = [...host.querySelectorAll('[role="tablist"], [data-testid="settings-team-workspace"]')];
      expect(menus.map((node) => node.textContent).join(' '), entry.id).not.toMatch(/\p{Script=Han}/u);
      expect(menus.map((node) => node.getAttribute('aria-label')).join(' '), entry.id).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it('changing the language swaps the words under the same elements: selection, scroll frame and content stay', () => {
    render('s=theme');
    const nav232 = host.querySelector('[data-console-panel="settings-nav"]');
    const content = host.querySelector('[data-testid="theme-settings-panel"]');
    const themeRow = host.querySelector('[data-testid="settings-entry-theme"]');
    expect(themeRow?.getAttribute('aria-current')).toBe('page');

    act(() => writeShellLanguage('en'));

    expect(entryText('theme')).toBe('Theme');
    expect(host.querySelector('[data-console-panel="settings-nav"]')).toBe(nav232);
    expect(host.querySelector('[data-testid="theme-settings-panel"]')).toBe(content);
    expect(host.querySelector('[data-testid="settings-entry-theme"]')).toBe(themeRow);
    expect(themeRow?.getAttribute('aria-current')).toBe('page');
    // the catalogue still gives way to the page under it on a narrow window (42vh, not shrunk)
    expect(nav232?.className).toContain('max-h-[42vh]');
  });

  it('the classic settings page never reads the language', () => {
    writeShellLanguage('en');
    writeShellPresentation('classic');
    render('s=notify');
    expect(host.querySelector('[data-testid="settings-v2"]')).toBeNull();
    expect(host.querySelector('nav[aria-label="设置导航"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Settings');
  });
});
