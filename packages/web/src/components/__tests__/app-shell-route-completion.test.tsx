// @vitest-environment jsdom

import React, { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => ({ pending: undefined as Promise<void> | undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/collective',
  useSearchParams: () => {
    if (query.pending) throw query.pending;
    return new URLSearchParams();
  },
}));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => false }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/stores/sidebarStore', () => ({
  initSidebarWidth: vi.fn(),
  useSidebarStore: () => ({ isOpen: false, width: 260, close: vi.fn(), handleResize: vi.fn(), resetWidth: vi.fn() }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (value: { rightPanelMode: string }) => unknown) => select({ rightPanelMode: 'none' }),
}));
vi.mock('@/stores/callbackAuthStore', () => ({ CallbackAuthSnapshotMount: () => null }));
vi.mock('@/components/ActivityBar', () => ({ ActivityBar: () => null }));
vi.mock('@/components/shell/WorldRail', () => ({ WorldRail: () => null }));
vi.mock('@/components/ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));
vi.mock('@/components/workspace/FloatingPresentationSurfaceHost', () => ({
  FloatingPresentationSurfaceHost: () => null,
}));
vi.mock('@/components/concierge/ConciergeHost', () => ({ ConciergeHost: () => null }));
vi.mock('@/components/thread-chat', () => ({
  ThreadChatRuntimeProvider: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock('@/components/listen-mode/ListenModePlayer', () => ({ ListenModePlayer: () => null }));
vi.mock('@/components/story-player/TheaterReplayHost', () => ({ TheaterReplayHost: () => null }));
vi.mock('@/components/DesktopUpdatePrompt', () => ({ DesktopUpdatePrompt: () => null }));
vi.mock('@/services/playbackRuntime', () => ({ getPlaybackManager: vi.fn(), destroyPlaybackRuntime: vi.fn() }));

import { AppShell } from '@/components/AppShell';

describe('AppShell route completion', () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounts: number;

  function Page() {
    const [channel, setChannel] = useState('Home');
    useEffect(() => {
      mounts += 1;
    }, []);
    return (
      <main>
        <button type="button" onClick={() => setChannel('产品方向')}>
          {channel}
        </button>
        <iframe title="Collective" src="about:blank" />
      </main>
    );
  }

  function suspendQuery() {
    let release!: () => void;
    query.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    return async () => {
      await act(async () => {
        query.pending = undefined;
        release();
      });
    };
  }

  function render() {
    act(() =>
      root.render(
        <AppShell>
          <Page />
        </AppShell>,
      ),
    );
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    query.pending = undefined;
    mounts = 0;
    window.history.replaceState(null, '', '/collective');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    query.pending = undefined;
    window.history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('mounts an interactive route only after the shell query has resolved', async () => {
    const release = suspendQuery();
    render();
    expect(container.querySelector('iframe')).toBeNull();
    expect(mounts).toBe(0);

    await release();
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(mounts).toBe(1);
    act(() => container.querySelector('button')?.click());
    render();
    expect(container.querySelector('iframe')).toBe(frame);
    expect(container.querySelector('button')?.textContent).toBe('产品方向');
    expect(mounts).toBe(1);
  });

  it('keeps the existing route identity and input through a later query suspension', async () => {
    render();
    const frame = container.querySelector('iframe');
    act(() => container.querySelector('button')?.click());
    const release = suspendQuery();
    render();
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(mounts).toBe(1);

    await release();
    expect(container.querySelector('iframe')).toBe(frame);
    expect(container.querySelector('button')?.textContent).toBe('产品方向');
    expect(mounts).toBe(1);
  });
});
