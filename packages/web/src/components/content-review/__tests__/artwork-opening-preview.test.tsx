import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaGalleryBlock } from '@/components/rich/MediaGalleryBlock';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { ArtworkLightboxHost } from '../ArtworkLightboxHost';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from '../ArtworkLightboxScope';
import type { ArtworkOpenResult } from '../usePublishedContent';

const mocks = vi.hoisted(() => ({ open: vi.fn(), fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: mocks.fetch }));
vi.mock('../useChatArtworkEntry', () => ({
  useChatArtworkEntry: () => ({
    isV2: true,
    busy: false,
    error: null,
    versionFor: () => undefined,
    source: () => ({ kind: 'workspace', worktreeId: 'listed-root', path: 'art/original.jpg' }),
    open: mocks.open,
  }),
}));
vi.mock('@/components/workbench/F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: () => <p data-testid="owner-test">正在核验原文件位置…</p>,
}));

const publication = { threadId: 'original-thread', messageId: 'original-message', messageRevision: '12' };
const url = '/api/workspace/file/raw?worktreeId=listed-root&path=art/original.jpg';
let root: Root, host: HTMLDivElement;
let scope: NonNullable<ReturnType<typeof useArtworkLightboxScope>>;
function Probe() {
  scope = useArtworkLightboxScope()!;
  return <input aria-label="original composer" defaultValue="unsent words" />;
}
function render(threadId = publication.threadId) {
  root.render(
    <ArtworkLightboxProvider threadId={threadId}>
      <MediaGalleryBlock
        publication={publication}
        block={{ kind: 'media_gallery', v: 1, id: 'gallery', items: [{ url, alt: '原图' }] }}
      />
      <Probe />
      <ArtworkLightboxHost />
    </ArtworkLightboxProvider>,
  );
}
function deferred() {
  let resolve!: (result: ArtworkOpenResult) => void;
  const promise = new Promise<ArtworkOpenResult>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  useChatStore.setState({ currentThreadId: publication.threadId, workspaceOpenRequest: null });
  mocks.open.mockReset();
  mocks.fetch.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});
async function clickPicture() {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label^="打开作品"]');
  if (!button) throw new Error('the original picture is missing');
  await act(async () => button.click());
}
const admitted: ArtworkOpenResult = {
  status: 'opened',
  target: { kind: 'file', worktreeId: 'listed-root', path: 'art/original.jpg' },
};

it('shows the already displayed picture and title while the original owner read is still pending', async () => {
  const owner = deferred();
  mocks.open.mockReturnValue(owner.promise);
  await act(async () => render());
  const composer = host.querySelector('input');
  await clickPicture();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog, 'owner latency must not leave the clicked picture behind a spinner').not.toBeNull();
  expect(dialog?.querySelector('img')?.getAttribute('src')).toBe(`http://api.test${url}`);
  expect(dialog?.textContent).toContain('原图');
  expect(scope.work?.surface, 'a preview is not a verified owner surface').toBeNull();
  expect(document.querySelector('[data-testid="owner-test"]')).toBeNull();
  expect(host.querySelector('input')).toBe(composer);
  expect(composer?.value).toBe('unsent words');
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});

it('keeps the picture visible when admission finishes but the version owner is still preparing', async () => {
  const owner = deferred();
  mocks.open.mockReturnValue(owner.promise);
  await act(async () => render());
  await clickPicture();
  await act(async () => owner.resolve(admitted));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.querySelector('[data-testid="owner-test"]')).not.toBeNull();
  expect(dialog?.querySelector('img')?.getAttribute('src'), 'the next owner wait must not blank the cached image').toBe(
    `http://api.test${url}`,
  );
});

it('does not reopen or attach an owner after the user closes a still-pending preview', async () => {
  const owner = deferred();
  mocks.open.mockReturnValue(owner.promise);
  await act(async () => render());
  await clickPicture();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => scope.close());
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label^="打开作品"]')?.disabled,
    'closing the preview must not leave its Chat opener disabled by an obsolete owner request',
  ).toBe(false);
  await act(async () => owner.resolve(admitted));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(scope.work).toBeNull();
});

it('removes a preview refused by its original owner instead of enabling annotation from its URL', async () => {
  const owner = deferred();
  mocks.open.mockReturnValue(owner.promise);
  await act(async () => render());
  await clickPicture();
  await act(async () => owner.resolve({ status: 'blocked' }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[data-testid="owner-test"]')).toBeNull();
});

it('ignores the previous thread owner result while preserving the original mounted composer', async () => {
  const owner = deferred();
  mocks.open.mockReturnValue(owner.promise);
  await act(async () => render());
  const composer = host.querySelector('input');
  await clickPicture();
  await act(async () => {
    useChatStore.setState({ currentThreadId: 'another-thread' });
    render('another-thread');
  });
  await act(async () => owner.resolve(admitted));
  expect(scope.work).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('input')).toBe(composer);
});
