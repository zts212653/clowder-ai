import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useResolveContentSurface } from '@/components/workbench/ContentSurfaceResolution';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createFilePreviewSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { useArtworkGallery } from '../ArtworkGalleryScope';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from '../ArtworkLightboxScope';
import { ArtworkWorkModeScope } from '../ArtworkWorkModeScope';

let scope: NonNullable<ReturnType<typeof useArtworkLightboxScope>>;
function Consumer() {
  scope = useArtworkLightboxScope()!;
  return <input aria-label="preserved composer host" defaultValue="local draft" />;
}
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="thread-a">
        <Consumer />
      </ArtworkLightboxProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState() });
});
function work(path: string) {
  return {
    url: `http://api.test/${path}`,
    title: path,
    alt: path,
    mediaType: 'image' as const,
    surface: createFilePreviewSurface({
      worktreeId: 'listed-alias',
      path,
      navigationOrigin: { kind: 'chat-file-link', threadId: 'thread-a', messageId: `original-${path}` },
    }),
  };
}
it('canonical file resolution in a float retains the original Chat return without changing Workbench topology', async () => {
  const before = useF307ExperienceWorkbenchStore.getState();
  const original = work('original.png');
  await act(async () => scope.open(original));
  await act(async () =>
    scope.resolve(createFilePreviewSurface({ worktreeId: 'canonical-root', path: 'original.png' })),
  );
  expect(scope.work?.surface?.navigationOrigin).toEqual(original.surface.navigationOrigin);
  expect(scope.work?.surface?.ownerStateRef.key).toBe('canonical-root');
  expect(useF307ExperienceWorkbenchStore.getState()).toBe(before);
});
it('a late resolution from a previous floating work cannot replace the newly opened work', async () => {
  await act(async () => scope.open(work('first.png')));
  const late = scope.resolve;
  const next = work('second.png');
  await act(async () => scope.open(next));
  await act(async () => late(createFilePreviewSurface({ worktreeId: 'canonical-root', path: 'first.png' })));
  expect(scope.work).toBe(next);
});

it('keeps the work-mode gallery when its selected unannotated file resolves from an alias to its canonical owner', async () => {
  const original = work('unannotated-second.png');
  const canonical = createFilePreviewSurface({ worktreeId: 'canonical-root', path: original.title });
  const layout = {
    ...createInitialWorkbenchState(),
    surfaces: [original.surface],
    activeSurfaceId: original.surface.id,
  };
  useF307ExperienceWorkbenchStore.setState({ layout });
  function Resolution() {
    const resolve = useResolveContentSurface(original.surface.id);
    const gallery = useArtworkGallery();
    return (
      <button type="button" onClick={() => resolve(canonical)}>
        {gallery ? `${gallery.index + 1} / ${gallery.items.length}` : 'no gallery'}
      </button>
    );
  }
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="thread-a">
        <Consumer />
        <ArtworkWorkModeScope onReturn={() => {}}>
          <Resolution />
        </ArtworkWorkModeScope>
      </ArtworkLightboxProvider>,
    ),
  );
  const gallery = { items: [work('first.png'), original, work('third.png')], index: 1, onSelect: () => {} };
  await act(async () => scope.enterWorkMode({ ...original, gallery }));
  expect(host.querySelector('button')?.textContent).toBe('2 / 3');
  const composer = host.querySelector('input');
  await act(async () => host.querySelector('button')?.click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(canonical.id);
  expect(host.querySelector('button')?.textContent).toBe('2 / 3');
  expect(scope.workModeWork?.surface?.id).toBe(canonical.id);
  expect(scope.workModeWork?.gallery).toBe(gallery);
  expect(scope.workModeWork?.surface?.navigationOrigin).toEqual(original.surface.navigationOrigin);
  expect(host.querySelector('input')).toBe(composer);
});

it.each(['second.png', 'first.png'])('ignores a previous work-mode resolution after opening %s again', async (path) => {
  const first = work('first.png');
  await act(async () => scope.enterWorkMode(first));
  const late = scope.resolveWorkMode;
  const current = work(path);
  await act(async () => scope.enterWorkMode(current));
  await act(async () =>
    late(createFilePreviewSurface({ worktreeId: 'canonical-root', path: first.title }), first.surface.id),
  );
  expect(scope.workModeWork).toBe(current);
});

it('keeps the mounted owner editor and its unsaved text when work-mode intent changes', async () => {
  const render = (active: boolean) =>
    act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId="thread-a">
          <ArtworkWorkModeScope onReturn={active ? () => {} : null}>
            <input aria-label="owner editor" defaultValue="original owner text" />
          </ArtworkWorkModeScope>
        </ArtworkLightboxProvider>,
      ),
    );
  await render(false);
  const editor = host.querySelector('input');
  if (!editor) throw new Error('the original mounted owner editor is required');
  editor.value = 'unsaved owner text';
  await render(true);
  expect(host.querySelector('input')).toBe(editor);
  expect(editor.value).toBe('unsaved owner text');
  await render(false);
  expect(host.querySelector('input')).toBe(editor);
});

it('resets only the floating presentation across threads and ignores callbacks from the previous visit', async () => {
  const switchThread = (threadId: string) =>
    act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId={threadId}>
          <Consumer />
        </ArtworkLightboxProvider>,
      ),
    );
  const composer = host.querySelector('input');
  await act(async () => scope.open(work('original.png')));
  const oldOpen = scope.open;
  const oldClose = scope.close;
  const oldResolve = scope.resolve;
  await switchThread('thread-b');
  expect(scope.work).toBeNull();
  expect(host.querySelector('input')).toBe(composer);
  await act(async () => oldOpen(work('late-a.png')));
  expect(scope.work).toBeNull();

  // Returning to the same id is a new visit; old A callbacks still have no authority.
  await switchThread('thread-a');
  const current = work('original.png');
  await act(async () => scope.open(current));
  await act(async () => {
    oldResolve(createFilePreviewSurface({ worktreeId: 'stale-root', path: 'original.png' }));
    oldClose();
    oldOpen(work('late-a.png'));
  });
  expect(scope.work).toBe(current);
  expect(host.querySelector('input')).toBe(composer);
});
