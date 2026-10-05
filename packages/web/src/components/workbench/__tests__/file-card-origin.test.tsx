import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { captureFileCardOrigin, FILE_RETURN_PARAM, fileCardReturnHref, parseFileCardOrigin } from '../file-card-origin';
import { createFileSurface } from '../real-surface-adapters';
import { useFileCardReturn } from '../useFileCardReturn';
import { WorkspaceSurfaceVisibilityProvider } from '../WorkspaceSurfaceVisibility';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';
import { workspaceFileReturnAction } from '../workspace-file-return';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('file origin coordinates', () => {
  it('does not consume a return coordinate in the previous thread with the same card id', async ({
    onTestFinished,
  }) => {
    const container = document.createElement('div');
    container.dataset.fileOriginScroll = '';
    document.body.appendChild(container);
    const root = createRoot(container);
    onTestFinished(async () => {
      await act(async () => root.unmount());
      container.remove();
    });
    function Card({ threadId }: { threadId: string }) {
      const ref = useFileCardReturn<HTMLElement>('runtime-logs', threadId);
      return (
        <section ref={ref} tabIndex={-1}>
          {threadId}
        </section>
      );
    }
    window.history.replaceState(
      {},
      '',
      fileCardReturnHref({
        kind: 'workspace-card',
        destination: 'status',
        threadId: 'original',
        anchorId: 'runtime-logs',
        viewportOffsetPx: 0,
      }),
    );
    await act(async () => root.render(<Card threadId="previous" />));
    expect(new URL(window.location.href).searchParams.has(FILE_RETURN_PARAM)).toBe(true);
    expect(document.activeElement).not.toBe(container.querySelector('section'));
    await act(async () => root.render(<Card threadId="original" />));
    expect(new URL(window.location.href).searchParams.has(FILE_RETURN_PARAM)).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('section'));
  });
  it('restores the original card descriptor while dropping an invalid navigation target', () => {
    const origin = {
      kind: 'settings' as const,
      href: '/settings?s=env',
      anchorId: 'settings-file:AGENTS.md',
      viewportOffsetPx: 15,
    };
    const surface = createFileSurface({ worktreeId: 'work', path: 'AGENTS.md', navigationOrigin: origin });
    const saved = JSON.parse(JSON.stringify(createInitialWorkbenchState([surface])));
    expect(restoreWorkbenchState(saved).surfaces[0]?.navigationOrigin).toEqual(origin);
    saved.surfaces[0].navigationOrigin.href = 'https://outside.invalid/settings';
    expect(restoreWorkbenchState(saved).surfaces).toEqual([]);
  });
  it.each([
    'https://evil.test/settings',
    '//evil.test/settings',
    '/settings-evil',
    '/settings\\evil',
    '/settings\u0000',
  ])('rejects a non-settings navigation target %s', (href) => {
    expect(parseFileCardOrigin({ kind: 'settings', href, anchorId: 'card', viewportOffsetPx: 20 })).toBeNull();
  });
  it('captures the original settings query and card offset without nesting old return coordinates', () => {
    window.history.replaceState({}, '', '/settings?s=ops&ops=observability&obs=eval&fileReturn=old');
    const container = document.createElement('div');
    container.dataset.trajectoryOriginScroll = '';
    const card = document.createElement('section');
    container.appendChild(card);
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 12 } as DOMRect);
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 53 } as DOMRect);
    const origin = captureFileCardOrigin(card, 'eval:one', 'thread-before', 'eval');
    expect(origin).toEqual({
      kind: 'settings',
      href: '/settings?s=ops&ops=observability&obs=eval',
      anchorId: 'eval:one',
      viewportOffsetPx: 41,
    });
    expect(workspaceFileReturnAction(origin, 'different-file-worktree')).toEqual(origin);
    expect(parseFileCardOrigin(JSON.parse(JSON.stringify(origin)))).toEqual(origin);
    expect(new URL(fileCardReturnHref(origin), window.location.origin).searchParams.get('obs')).toBe('eval');
  });
  it('captures the original workspace destination, thread and card instead of the opened file', () => {
    window.history.replaceState({}, '', '/thread/source');
    const origin = captureFileCardOrigin(null, 'runtime-logs', 'source', 'status');
    expect(origin).toEqual({
      kind: 'workspace-card',
      threadId: 'source',
      destination: 'status',
      anchorId: 'runtime-logs',
      viewportOffsetPx: 0,
    });
    expect(workspaceFileReturnAction(origin, 'log-worktree')).toEqual(origin);
    expect(parseFileCardOrigin({ ...origin, destination: 'untrusted' })).toBeNull();
    expect(parseFileCardOrigin({ ...origin, viewportOffsetPx: Infinity })).toBeNull();
  });
  it('restores a late-mounted visible card exactly once and leaves unrelated settings query intact', async ({
    onTestFinished,
  }) => {
    const container = document.createElement('div');
    container.dataset.trajectoryOriginScroll = '';
    container.scrollTop = 200;
    document.body.appendChild(container);
    const root = createRoot(container);
    onTestFinished(async () => {
      await act(async () => root.unmount());
      container.remove();
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top: this === container ? 10 : 310 } as DOMRect;
    });
    function Card() {
      const ref = useFileCardReturn<HTMLElement>('eval:one');
      return (
        <section ref={ref} tabIndex={-1}>
          原结论
        </section>
      );
    }
    const href = fileCardReturnHref({
      kind: 'settings',
      href: '/settings?s=ops&obs=eval',
      anchorId: 'eval:one',
      viewportOffsetPx: 50,
    });
    window.history.replaceState({}, '', href);
    await act(async () =>
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible={false}>
          <Card />
        </WorkspaceSurfaceVisibilityProvider>,
      ),
    );
    expect(container.scrollTop).toBe(200);
    expect(new URL(window.location.href).searchParams.has(FILE_RETURN_PARAM)).toBe(true);
    await act(async () =>
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible>
          <Card />
        </WorkspaceSurfaceVisibilityProvider>,
      ),
    );
    expect(container.scrollTop).toBe(450);
    expect(document.activeElement).toBe(container.querySelector('section'));
    expect(window.location.search).toBe('?s=ops&obs=eval');
    await act(async () =>
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible>
          <Card />
        </WorkspaceSurfaceVisibilityProvider>,
      ),
    );
    expect(container.scrollTop).toBe(450);
  });
});
