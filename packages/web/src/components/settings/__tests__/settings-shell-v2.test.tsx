import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
  pathname: '/settings',
}));
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
  SettingsContent: ({ section, initialEditCatId }: { section: string; initialEditCatId?: string }) => (
    <div data-testid="content" data-section={section} data-cat={initialEditCatId ?? ''} />
  ),
}));
vi.mock('../ThemeSettingsPanel', () => ({ ThemeSettingsPanel: () => <div data-testid="theme-settings-panel" /> }));
vi.mock('../plugin-manager/plugin-manager-design-gate', () => ({ usesFixedPluginManagerLayout: () => false }));

import { writeShellPresentation } from '../../shell/shell-presentation';
import { SettingsShell } from '../SettingsShell';

describe('F322 设置与管理 shell (v2)', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render(search: string) {
    nav.search = search;
    // Rail/destination navigation reads the real location for the `from` referrer, exactly as in the browser.
    window.history.replaceState(null, '', search ? `/settings?${search}` : '/settings');
    act(() => root.render(<SettingsShell />));
  }
  const click = (testId: string) => {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`${testId} missing`);
    act(() => el.click());
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    pins.pinned = [];
    nav.pathname = '/settings';
    writeShellPresentation('v2');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows 11 first-level items and lands on 猫猫团队 › 成员与运行时 by default', () => {
    render('');
    expect(host.querySelectorAll('[data-testid^="settings-entry-"]')).toHaveLength(11);
    expect(host.querySelector('[data-testid="settings-entry-team"]')?.getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('[data-testid="content"]')?.getAttribute('data-section')).toBe('members');
  });

  it('old /settings?s= links and extra positioning params keep working, including deep-linked cat editing', () => {
    render('s=accounts&cat=opus');
    expect(host.querySelector('[data-testid="settings-entry-connect"]')?.getAttribute('aria-current')).toBe('page');
    const content = host.querySelector('[data-testid="content"]');
    expect(content?.getAttribute('data-section')).toBe('accounts');
    render('s=members&cat=opus');
    expect(host.querySelector('[data-testid="content"]')?.getAttribute('data-cat')).toBe('opus');
    render('ops=agent-sessions');
    expect(host.querySelector('[data-testid="content"]')?.getAttribute('data-section')).toBe('ops');
    expect(host.querySelector('[data-testid="settings-entry-system"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('choosing a section-based entry selects its first old section and keeps the other query params', () => {
    render('from=thread-1&cat=opus');
    click('settings-entry-connect');
    expect(nav.replace).toHaveBeenCalledTimes(1);
    const url = String(nav.replace.mock.calls[0]?.[0]);
    expect(url).toContain('s=accounts');
    expect(url).toContain('from=thread-1');
    expect(url).toContain('cat=opus');
  });

  it('second-level tabs are the old sections of that entry, by their old names', () => {
    render('s=system');
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['系统配置', '协作与规则', '语音管理', '通知', '运维监控']);
    click('settings-tab-voice');
    expect(String(nav.replace.mock.calls[0]?.[0])).toContain('s=voice');
  });

  it('entries that live elsewhere open the place that owns them instead of copying it', () => {
    render('from=thread-1');
    click('settings-entry-signals');
    expect(nav.push).toHaveBeenLastCalledWith('/signals?from=thread-1');
    click('settings-entry-starry');
    expect(nav.push).toHaveBeenLastCalledWith('/starry?from=thread-1');

    // The conversation's Workspace panels open in the last conversation, so we also navigate back to it.
    click('settings-entry-schedule');
    expect(chat.setWorkspaceMode).toHaveBeenLastCalledWith('schedule');
    expect(nav.push).toHaveBeenLastCalledWith('/thread/thread-1');
    click('settings-entry-eval');
    expect(chat.setWorkspaceMode).toHaveBeenLastCalledWith('eval');
    click('settings-entry-community');
    expect(chat.setWorkspaceMode).toHaveBeenLastCalledWith('community');
  });

  it('team member abilities & routing stays reachable as a second-level item of 猫猫团队', () => {
    render('from=thread-1');
    click('settings-team-workspace');
    expect(chat.openTeamSubject).toHaveBeenCalledWith(null);
  });

  it('主题 is a real panel reached at s=theme', () => {
    render('s=theme');
    expect(host.querySelector('[data-testid="theme-settings-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="settings-entry-theme"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('any first-level or second-level item can be pinned; first-level pins are namespaced', () => {
    render('s=system');
    const toggles = [...host.querySelectorAll<HTMLElement>('[data-testid="settings-pin-toggle"]')];
    act(() => host.querySelector<HTMLElement>('button[aria-label="固定「猫猫团队」到侧栏"]')?.click());
    expect(pins.pin).toHaveBeenLastCalledWith('dest:team');
    // the selected second-level item (old section id) is pinnable
    act(() => host.querySelector<HTMLElement>('button[aria-label="固定「系统配置」到侧栏"]')?.click());
    expect(pins.pin).toHaveBeenLastCalledWith('system');
    expect(toggles.length).toBeGreaterThan(11);
  });

  it('the Workspace team panel is pinnable under its own identity, not as dest:team', () => {
    render('');
    act(() => host.querySelector<HTMLElement>('button[aria-label="固定「成员能力与路由状态」到侧栏"]')?.click());
    expect(pins.pin).toHaveBeenLastCalledWith('dest:team-workspace');
  });

  it('standalone (pinned section) view and the classic shell are untouched', () => {
    render('s=notify&standalone=1');
    expect(host.querySelector('[data-testid="settings-v2"]')).toBeNull();
    expect(host.querySelector('[data-testid="content"]')?.getAttribute('data-section')).toBe('notify');
    writeShellPresentation('classic');
    render('s=notify');
    expect(host.querySelector('[data-testid="settings-v2"]')).toBeNull();
    expect(host.querySelector('nav[aria-label="设置导航"]')).not.toBeNull();
  });
});
