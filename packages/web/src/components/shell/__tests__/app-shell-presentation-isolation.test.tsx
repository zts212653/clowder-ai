import React, { act, useEffect, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/thread/current', search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/stores/sidebarStore', () => ({
  initSidebarWidth: vi.fn(),
  useSidebarStore: () => ({ isOpen: true, width: 260, close: vi.fn(), handleResize: vi.fn(), resetWidth: vi.fn() }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (s: (v: { rightPanelMode: string }) => unknown) => s({ rightPanelMode: 'none' }),
}));
vi.mock('@/stores/callbackAuthStore', () => ({ CallbackAuthSnapshotMount: () => null }));
vi.mock('@/components/ActivityBar', () => ({ ActivityBar: () => <nav data-testid="classic-rail" /> }));
vi.mock('../WorldRail', () => ({ WorldRail: () => <nav data-testid="v2-rail" /> }));
vi.mock('@/components/ThreadSidebar', () => ({ ThreadSidebar: () => <aside data-testid="sidebar" /> }));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));
vi.mock('@/components/workspace/FloatingPresentationSurfaceHost', () => ({
  FloatingPresentationSurfaceHost: () => null,
}));
vi.mock('@/components/concierge/ConciergeHost', () => ({ ConciergeHost: () => null }));
vi.mock('@/components/thread-chat', () => ({
  ThreadChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/listen-mode/ListenModePlayer', () => ({ ListenModePlayer: () => null }));
vi.mock('@/components/story-player/TheaterReplayHost', () => ({ TheaterReplayHost: () => null }));
vi.mock('@/components/DesktopUpdatePrompt', () => ({ DesktopUpdatePrompt: () => null }));
vi.mock('@/services/playbackRuntime', () => ({ getPlaybackManager: vi.fn(), destroyPlaybackRuntime: vi.fn() }));

import { AppShell } from '@/components/AppShell';
import { useWorkspaceNavigate } from '@/hooks/useWorkspaceNavigate';
import { captureChatReadingRef } from '@/utils/chat-scroll-memory';
import { pushThreadRouteWithHistory } from '../../ThreadSidebar/thread-navigation';
import type { ChatReadingPort } from '../../thread-chat/useThreadChatReadingPort';
import { readSettingsReadingSession } from '../settings-reading-session';
import { SHELL_PRESENTATION_STORAGE_KEY, useShellPresentation, writeShellPresentation } from '../shell-presentation';
import { useSettingsReadingEntry, useSettingsReadingPort, useSettingsSourceReturn } from '../useSettingsSourceReturn';

const sourceReader: ChatReadingPort = {
  threadId: 'current',
  ownerId: 'original-reader',
  captureReadingRef: () =>
    captureChatReadingRef({
      threadId: 'current',
      position: { top: 320, anchor: 'offset', messageAnchor: { messageId: 'm20', viewportOffsetPx: 42 } },
    }),
  restoreReadingRef: async () => ({ status: 'unavailable' }),
  releaseReadingRef: () => true,
  navigateToMessage: async () => ({ status: 'unavailable' }),
};
function SettingsSourceProbe() {
  const register = useSettingsReadingPort('Actual source title');
  const capture = useSettingsReadingEntry();
  const source = useSettingsSourceReturn();
  useEffect(() => register(sourceReader), [register]);
  return (
    <>
      <button type="button" data-testid="capture-source" onClick={capture}>
        Capture
      </button>
      <output data-testid="source-label">{source?.label ?? ''}</output>
    </>
  );
}
// Next commits the address after its route-state render. No popstate is fired by this commit.
function CommitNextAddress({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  useLayoutEffect(() => {
    window.history.replaceState(null, '', pathname);
  }, [pathname]);
  return children;
}

describe('F322 AppShell presentation isolation', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render() {
    act(() =>
      root.render(
        <AppShell>
          <input aria-label="draft" defaultValue="unsent" />
        </AppShell>,
      ),
    );
  }
  function expectShell(v2: boolean) {
    expect(document.documentElement.dataset.shell).toBe(v2 ? 'v2' : undefined);
    expect(host.querySelectorAll('[data-testid="v2-rail"]')).toHaveLength(v2 ? 1 : 0);
    expect(host.querySelectorAll('[data-testid="classic-rail"]')).toHaveLength(v2 ? 0 : 1);
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    nav.pathname = '/thread/current';
    nav.search = '';
    window.history.replaceState(null, '', nav.pathname);
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    delete document.documentElement.dataset.shell;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    writeShellPresentation('classic');
    host.remove();
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    window.history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('default classic, v2, and back do not share rails or remount the unsent draft', () => {
    render();
    expectShell(false);
    const draft = host.querySelector('input');
    if (!draft) throw new Error('Unsent draft input is missing');
    draft.value = 'still unsent';
    act(() => writeShellPresentation('v2'));
    expectShell(true);
    expect(host.querySelector('input')).toBe(draft);
    act(() => writeShellPresentation('classic'));
    expectShell(false);
    expect(draft.value).toBe('still unsent');
  });
  it('paints the explicit v2 URL and its route children consistently before passive effects', () => {
    nav.search = 'shell=v2';
    const paints: string[] = [];
    function FirstPaintProbe() {
      const presentation = useShellPresentation();
      useLayoutEffect(() => {
        paints.push(presentation);
      }, [presentation]);
      return <output>{presentation}</output>;
    }
    act(() =>
      root.render(
        <AppShell>
          <FirstPaintProbe />
        </AppShell>,
      ),
    );
    expect(paints[0]).toBe('v2');
    expectShell(true);
  });
  it('keeps the URL selection and manual changes when storage rejects writes, then accepts cross-tab changes', () => {
    nav.search = 'shell=v2';
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError');
    });
    render();
    expectShell(true);
    act(() => writeShellPresentation('classic'));
    expectShell(false);
    act(() => writeShellPresentation('v2'));
    expectShell(true);
    vi.restoreAllMocks();
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'classic');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: SHELL_PRESENTATION_STORAGE_KEY })));
    expectShell(false);
  });
  it('shows the captured Settings source after a Next address commit without a synthetic browser event', () => {
    writeShellPresentation('v2');
    const renderSource = () =>
      act(() =>
        root.render(
          <CommitNextAddress pathname={nav.pathname}>
            <AppShell>
              <SettingsSourceProbe />
            </AppShell>
          </CommitNextAddress>,
        ),
      );
    renderSource();
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="capture-source"]')?.click());
    expect(readSettingsReadingSession()?.label).toBe('Actual source title');
    nav.pathname = '/settings';
    renderSource();
    expect(window.location.pathname).toBe('/settings');
    expect(host.querySelector('[data-testid="source-label"]')?.textContent).toBe('Actual source title');
  });
  it('follows the original thread-history event without a Next navigation or remounting the draft', () => {
    render();
    const draft = host.querySelector('input');
    if (!draft) throw new Error('Unsent draft input is missing');
    draft.value = 'still unsent';
    act(() => pushThreadRouteWithHistory('other', window));
    expect(nav.pathname).toBe('/thread/current');
    expect(window.location.pathname).toBe('/thread/other');
    expect(vi.mocked(useWorkspaceNavigate).mock.calls.at(-1)?.[0]).toBe('other');
    expect(host.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('still unsent');
  });
  it.each([
    'v2',
    'classic',
  ] as const)('initial ?shell=%s takes precedence over the opposite preference', (requested) => {
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, requested === 'v2' ? 'classic' : 'v2');
    nav.search = `shell=${requested}`;
    window.history.replaceState(null, '', `${nav.pathname}?${nav.search}`);
    render();
    expectShell(requested === 'v2');
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBe(requested);
  });
  it('cross-tab preference changes replace the rail and remove v2 tokens', () => {
    render();
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    act(() =>
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_PRESENTATION_STORAGE_KEY, newValue: 'v2' })),
    );
    expectShell(true);
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'classic');
    act(() =>
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_PRESENTATION_STORAGE_KEY, newValue: 'classic' })),
    );
    expectShell(false);
  });
  it('unmount cleans the html presentation attribute', () => {
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    render();
    expectShell(true);
    act(() => root.render(null));
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});
