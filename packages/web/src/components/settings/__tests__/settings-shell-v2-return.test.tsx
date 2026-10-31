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

// The C navigation owner's hook. The Settings shell only reads what it returns; the producer is tested on its own. Only the
// reader is replaced: the same module also hands `use-open-destination` its entry hook, which runs for real (no provider, so it
// captures nothing).
type SourceReturn = Readonly<{ label: string; onReturn: () => void }> | null;
const source = vi.hoisted(() => ({ value: null as SourceReturn }));
vi.mock('../../shell/useSettingsSourceReturn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shell/useSettingsSourceReturn')>()),
  useSettingsSourceReturn: () => source.value,
}));

import { SHELL_LANGUAGE_STORAGE_KEY, writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SettingsShell } from '../SettingsShell';

/**
 * F322 B (home-northstar README §1.15, DESIGN.md「导航」 return rule) — the top of the 设置与管理 catalogue says the way back: 「‹ 返回
 * {对话名}」 / 「‹ Back to {conversation}」, the previous level's NAME, never a bare "Back". The title is the source conversation's real
 * title, which the navigation owner supplies (non-null means a real, non-empty title; no real source means null); this shell adds only
 * the surrounding words in the shell language, reads no `?from=`, and calls `onReturn` and nothing else. New shell only.
 */
describe('F322 设置与管理: the way back to the source conversation', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onReturn = vi.fn();
  function render(search = 's=theme') {
    nav.search = search;
    window.history.replaceState(null, '', search ? `/settings?${search}` : '/settings');
    act(() => root.render(<SettingsShell />));
  }
  const row = () => host.querySelector<HTMLButtonElement>('[data-testid="settings-return"]');
  /** What a screen reader says: the visible words minus the decorative chevron. */
  const spoken = (el: Element) =>
    [...el.childNodes]
      .filter((node) => !(node instanceof HTMLElement && node.getAttribute('aria-hidden') === 'true'))
      .map((node) => node.textContent)
      .join('');
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    pins.pinned = [];
    nav.pathname = '/settings';
    source.value = null;
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

  it('no real source: no row and no empty slot, the title is still the first thing in the catalogue', () => {
    render();
    expect(row()).toBeNull();
    expect(host.querySelector('aside')?.firstElementChild?.querySelector('h1')?.textContent).toBe('设置与管理');
    expect(host.textContent).not.toContain('返回');
  });

  it('a real source: 「‹ 返回 {对话名}」 as a button, the chevron decorative, the name spoken in full', () => {
    source.value = { label: 'F322 Workspace', onReturn };
    render();
    const el = row();
    expect(el?.tagName).toBe('BUTTON');
    expect(el?.getAttribute('type')).toBe('button');
    expect(el?.querySelector('[aria-hidden="true"]')?.textContent).toBe('‹');
    expect(spoken(el as HTMLElement)).toBe('返回 F322 Workspace');
  });

  it('reads 「Back to {conversation}」 once the shell is English, and back again in Chinese', () => {
    source.value = { label: 'F322 Workspace', onReturn };
    writeShellLanguage('en');
    render();
    expect(spoken(row() as HTMLElement)).toBe('Back to F322 Workspace');
    writeShellLanguage('zh');
    render();
    expect(spoken(row() as HTMLElement)).toBe('返回 F322 Workspace');
  });

  it('is the first thing in the catalogue, above the 设置与管理 title', () => {
    source.value = { label: '对话甲', onReturn };
    render();
    const title = host.querySelector('h1') as HTMLElement;
    expect(row()?.compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(host.querySelector('aside')?.firstElementChild?.contains(row())).toBe(true);
  });

  it('a click calls onReturn once and does nothing else (no navigation of its own, no route referrer)', () => {
    source.value = { label: '对话甲', onReturn };
    render('s=theme&from=%2Fthread%2Fabc');
    act(() => row()?.click());
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a long title stays whole in the document and is cut by the layout, not by the code; no native title', () => {
    const label =
      '这是一个非常非常长的对话标题，长到在两百三十二像素宽的目录里一定放不下 — and its English tail goes on and on';
    source.value = { label, onReturn };
    render();
    const words = row()?.querySelector('span:not([aria-hidden="true"])') as HTMLElement;
    expect(words.textContent).toBe(`返回 ${label}`);
    expect(words.className).toContain('truncate');
    expect(words.className).toContain('min-w-0');
    expect(row()?.hasAttribute('title')).toBe(false);
  });

  it('writes the title as text: markup in a conversation name is not interpreted', () => {
    source.value = { label: '<b>粗</b><img src=x onerror=alert(1)>', onReturn };
    render();
    expect(row()?.querySelector('b')).toBeNull();
    expect(row()?.querySelector('img')).toBeNull();
    expect(spoken(row() as HTMLElement)).toBe('返回 <b>粗</b><img src=x onerror=alert(1)>');
  });

  it('follows the source: a different title replaces the words, and losing the source removes the row', () => {
    source.value = { label: '对话甲', onReturn };
    render();
    expect(spoken(row() as HTMLElement)).toBe('返回 对话甲');
    source.value = { label: '对话乙', onReturn };
    render();
    expect(spoken(row() as HTMLElement)).toBe('返回 对话乙');
    source.value = null;
    render();
    expect(row()).toBeNull();
  });

  it('classic is frozen: it has no such row, even if the hook has a source', () => {
    writeShellPresentation('classic');
    source.value = { label: '对话甲', onReturn };
    render();
    expect(row()).toBeNull();
    expect(host.textContent).not.toContain('返回 对话甲');
  });
});
