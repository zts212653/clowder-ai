import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { Lightbox } from '@/components/Lightbox';
import { artifactObjectId, createFilePreviewSurface } from '@/components/workbench/real-surface-adapters';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { HomeWorksSummary } from '../HomeWorksSummary';

const data = vi.hoisted(() => ({ artifacts: [] as ThreadArtifactDTO[], loading: false }));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ ...data, works: data.artifacts, total: data.artifacts.length, complete: true }),
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
// Publication admission is a boundary; the real Home, scope and Lightbox lifecycle run below.
vi.mock('@/components/content-review/useArtifactLightbox', () => ({
  useArtifactLightbox: () => {
    const scope = useArtworkLightboxScope();
    return {
      error: null,
      open: (artifact: ThreadArtifactDTO, origin: WorkspaceFileNavigationOrigin | undefined) => {
        scope?.open({
          url: artifact.url ?? '',
          title: artifact.name,
          alt: artifact.name,
          mediaType: 'image',
          surface: createFilePreviewSurface({ worktreeId: 'fixture', path: 'exact.png', navigationOrigin: origin }),
        });
        return !!scope;
      },
    };
  },
}));
function NativePreview() {
  const scope = useArtworkLightboxScope();
  return scope?.work ? <Lightbox url={scope.work.url} alt={scope.work.alt} onClose={scope.close} /> : null;
}
const artifact: ThreadArtifactDTO = {
  type: 'image',
  name: 'Exact original work',
  url: '/uploads/exact.png',
  createdAt: 1,
  sourceMessageId: 'original-message',
  catId: 'codex61-sol',
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
async function openAndReplace() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  host.dataset.testid = 'f307-workspace-home-page';
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  data.artifacts = [artifact];
  data.loading = false;
  const render = async (threadId = 'here') => {
    await act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId={threadId}>
          <HomeWorksSummary threadId={threadId} worktreeId="fixture" onSelectDestination={() => undefined} />
          <NativePreview />
        </ArtworkLightboxProvider>,
      ),
    );
  };
  await render();
  const original = host.querySelector<HTMLButtonElement>('[data-home-artifact-id]');
  if (!original) throw new Error('Original work card missing');
  original.focus();
  await act(async () => original.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  data.loading = true;
  await render();
  expect(original.isConnected).toBe(false);
  data.artifacts = [{ ...artifact }];
  data.loading = false;
  await render();
  const replacement = host.querySelector<HTMLButtonElement>('[data-home-artifact-id]');
  if (!replacement) throw new Error('Replacement work card missing');
  expect(replacement.getAttribute('data-home-artifact-id')).toBe(artifactObjectId(artifact));
  expect(replacement).not.toBe(original);
  return { host, replacement, render };
}
it('native preview returns to the exact replacement Home card after catalogue refresh', async () => {
  const { replacement } = await openAndReplace();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(replacement);
});
it('native preview close does not take focus away from another owner', async () => {
  await openAndReplace();
  const other = document.createElement('button');
  document.body.append(other);
  cleanups.push(() => other.remove());
  other.focus();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement).toBe(other);
});
it('native preview close cannot restore an origin from the previous thread', async () => {
  const { render, replacement } = await openAndReplace();
  await render('elsewhere');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement).not.toBe(replacement);
  expect(document.activeElement?.closest('[data-home-artifact-id]')).toBeNull();
});
