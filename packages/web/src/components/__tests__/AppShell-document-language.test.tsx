import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../AppShell';
import { SHELL_LANGUAGE_STORAGE_KEY, writeShellLanguage } from '../shell/shell-language';
import { writeShellPresentation } from '../shell/shell-presentation';

/**
 * F322 AC-B6–B8: the new shell's language is also the language of the document. `app/layout.tsx` declares `zh-CN` for every
 * page, so without a projection an English v2 page is announced by a screen reader as Chinese. The projection sits in the
 * same boundary that already projects `data-shell="v2"` onto <html>: it exists only while the shell is v2 (classic never reads
 * the language and keeps the layout's `zh-CN`), follows a write in this tab and a storage change from another tab, and gives
 * the layout's value back when v2 ends.
 */
const nav = vi.hoisted(() => ({ pathname: '/thread/x' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {} }),
}));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => false }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/stores/sidebarStore', () => ({
  useSidebarStore: () => ({ isOpen: false, width: 240, close: () => {}, handleResize: () => {}, resetWidth: () => {} }),
  initSidebarWidth: () => {},
}));
vi.mock('../ActivityBar', () => ({ ActivityBar: () => null }));
vi.mock('../ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../shell/WorldRail', () => ({ WorldRail: () => null }));
vi.mock('@/utils/api-client', () => ({
  refreshApiSession: () => Promise.resolve(false),
  API_URL: 'http://localhost:3112',
  apiFetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
}));

describe('the document language follows the new shell language', () => {
  let container: HTMLDivElement;
  let root: Root;
  const lang = () => document.documentElement.lang;
  const mount = () =>
    act(async () => {
      root.render(<AppShell>{React.createElement('div', null, 'content')}</AppShell>);
    });

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    (globalThis as { React?: typeof React }).React = undefined;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined;
  });
  beforeEach(() => {
    nav.pathname = '/thread/x';
    document.documentElement.lang = 'zh-CN'; // what app/layout.tsx declares
    window.localStorage.removeItem(SHELL_LANGUAGE_STORAGE_KEY);
    writeShellPresentation('classic');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem(SHELL_LANGUAGE_STORAGE_KEY);
    writeShellPresentation('classic');
    document.documentElement.lang = '';
  });

  it('classic never reads the language: English stored, the document stays zh-CN', async () => {
    writeShellLanguage('en');
    await mount();
    expect(lang()).toBe('zh-CN');
    act(() => writeShellLanguage('zh'));
    act(() => writeShellLanguage('en'));
    expect(lang()).toBe('zh-CN');
  });

  it('v2 in Chinese (the default) is zh-CN', async () => {
    writeShellPresentation('v2');
    await mount();
    expect(lang()).toBe('zh-CN');
  });

  it('v2 in English is en from the first paint of the shell', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    await mount();
    expect(lang()).toBe('en');
  });

  it('follows a write in this tab, both ways', async () => {
    writeShellPresentation('v2');
    await mount();
    act(() => writeShellLanguage('en'));
    expect(lang()).toBe('en');
    act(() => writeShellLanguage('zh'));
    expect(lang()).toBe('zh-CN');
  });

  it('follows another tab: a storage change flips the document with no write here', async () => {
    writeShellPresentation('v2');
    await mount();
    act(() => {
      window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_LANGUAGE_STORAGE_KEY, newValue: 'en' }));
    });
    expect(lang()).toBe('en');
  });

  it('gives the layout value back when v2 ends (to classic) and when the shell unmounts', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    await mount();
    expect(lang()).toBe('en');
    act(() => writeShellPresentation('classic'));
    expect(lang()).toBe('zh-CN');
    act(() => writeShellPresentation('v2'));
    expect(lang()).toBe('en');
    act(() => root.unmount());
    expect(lang()).toBe('zh-CN');
    root = createRoot(container); // the afterEach unmounts this one too
  });
});
