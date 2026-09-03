// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeState = vi.hoisted(() => ({
  routeThreadIds: [] as Array<string | null | undefined>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/thread/deep-link-thread',
  useSearchParams: () => {
    throw new Promise<never>(() => undefined);
  },
}));

vi.mock('@/components/thread-chat', () => ({
  ThreadChatRuntimeProvider: ({
    children,
    routeThreadId,
  }: {
    children: React.ReactNode;
    routeThreadId?: string | null;
  }) => {
    runtimeState.routeThreadIds.push(routeThreadId);
    return <>{children}</>;
  },
}));

vi.mock('@/components/DesktopUpdatePrompt', () => ({ DesktopUpdatePrompt: () => null }));
vi.mock('@/services/playbackRuntime', () => ({
  getPlaybackManager: vi.fn(),
  destroyPlaybackRuntime: vi.fn(),
}));

import { AppShell } from '@/components/AppShell';

describe('AppShell chat runtime fallback', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    runtimeState.routeThreadIds = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('scopes a suspended deep-link render to the route thread instead of default', () => {
    React.act(() => {
      root.render(
        <AppShell>
          <main>deep-link content</main>
        </AppShell>,
      );
    });

    expect(runtimeState.routeThreadIds).toEqual(['deep-link-thread']);
  });
});
