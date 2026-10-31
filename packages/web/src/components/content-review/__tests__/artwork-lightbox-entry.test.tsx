import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentBlocks } from '@/components/ContentBlocks';
import { useChatArtworkEntry } from '@/components/content-review/useChatArtworkEntry';
import type { ArtworkOpenResult } from '@/components/content-review/usePublishedContent';
import { FileBlock } from '@/components/rich/FileBlock';
import { MediaGalleryBlock } from '@/components/rich/MediaGalleryBlock';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
const publication = { threadId: 'host-thread', messageId: 'original-message', messageRevision: '12' };
const entries = [
  { kind: 'gallery', mime: 'image/png', path: 'art/original.png' },
  { kind: 'content-image', mime: 'image/png', path: 'art/original.png' },
  { kind: 'content-video', mime: 'video/mp4', path: 'art/original.mp4' },
  { kind: 'rich-video', mime: 'video/mp4', path: 'art/original.mp4' },
] as const;
type Entry = (typeof entries)[number];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  mocks.apiFetch.mockReset();
  useChatStore.setState({ currentThreadId: publication.threadId, workspaceOpenRequest: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

async function openEntry(entry: Entry) {
  const url = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: 'wt-a', path: entry.path })}`;
  mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ path: entry.path, mime: entry.mime })));
  await act(async () => {
    root.render(
      entry.kind === 'gallery' ? (
        <MediaGalleryBlock
          publication={publication}
          block={{ kind: 'media_gallery', v: 1, id: 'g', items: [{ url, alt: '原作品' }] }}
        />
      ) : entry.kind === 'rich-video' ? (
        <FileBlock
          publication={publication}
          block={{ kind: 'file', v: 1, id: 'v', url, fileName: '原片.mp4', mimeType: entry.mime }}
        />
      ) : (
        <ContentBlocks
          publication={publication}
          blocks={
            entry.kind === 'content-image'
              ? [{ type: 'image', url }]
              : [{ type: 'file', url, fileName: '原片.mp4', mimeType: entry.mime, fileSize: 24 }]
          }
        />
      ),
    );
  });
  const button = container.querySelector('button');
  if (!button) throw new Error('the original Chat media entry must be available');
  button.focus();
  await act(async () => button.click());
  return url;
}

it.each(
  entries,
)('v2 $kind opens the original media in a floating dialog before any Workspace navigation', async (entry) => {
  const url = await openEntry(entry);
  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
  expect(dialog?.querySelector(entry.mime === 'video/mp4' ? 'video' : 'img')?.getAttribute('src')).toBe(
    `http://api.test${url}`,
  );
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});

it('enters work mode directly from the floating image and keeps the original typed Chat return', async () => {
  await openEntry(entries[0]);
  const dialog = document.body.querySelector('[role="dialog"]');
  const openWorkspace = dialog?.querySelector<HTMLButtonElement>('[data-testid="lightbox-open-workspace"]');
  expect(openWorkspace).toBeTruthy();
  expect(openWorkspace?.textContent).toBe('作品模式');
  await act(async () => openWorkspace?.click());
  expect(useChatStore.getState().workspaceOpenRequest?.target).toEqual({
    kind: 'file',
    worktreeId: 'wt-a',
    path: entries[0].path,
    navigationOrigin: { kind: 'chat-file-link', threadId: publication.threadId, messageId: publication.messageId },
  });
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({ presentation: 'work-mode' });
});

it('the gallery Open action enters work mode directly while the picture itself still floats', async () => {
  await openEntry(entries[0]);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const open = [...container.querySelectorAll('button')].find((button) => button.textContent === '打开');
  expect(open).toBeTruthy();
  await act(async () => open?.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({
    presentation: 'work-mode',
    target: { kind: 'file', path: entries[0].path },
  });
});

it.each([
  'jpg',
  'webp',
])('a %s reaches the original floating owner without a format-only annotation refusal', async (extension) => {
  const entry = {
    ...entries[0],
    path: `art/original.${extension}`,
    mime: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
  };
  await openEntry(entry as Entry);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).toBeTruthy();
  await act(async () => dialog?.querySelector<HTMLButtonElement>('[data-testid="lightbox-open-workspace"]')?.click());
  expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({
    presentation: 'work-mode',
    target: { kind: 'file', path: entry.path },
  });
  // The owner must receive the unchanged file; removing a refusal label alone is insufficient.
  const result: { current?: ArtworkOpenResult } = {};
  function AdmissionProbe() {
    const artwork = useChatArtworkEntry(publication);
    return (
      <button
        type="button"
        onClick={async () => {
          result.current = await artwork.open(
            { kind: 'workspace', worktreeId: 'wt-a', path: entry.path },
            '原作品',
            'lightbox',
          );
        }}
      >
        open original
      </button>
    );
  }
  await act(async () => root.render(<AdmissionProbe />));
  const admit = container.querySelector<HTMLButtonElement>('button');
  if (!admit) throw new Error('original owner admission action missing');
  await act(async () => admit.click());
  expect(result.current).toMatchObject({
    status: 'opened',
    target: { kind: 'file', worktreeId: 'wt-a', path: entry.path },
  });
});

it('Escape closes the floating work and restores focus without opening Workspace', async () => {
  await openEntry(entries[0]);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('button'));
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});

it('a conversation switch closes a previously admitted floating work', async () => {
  await openEntry(entries[0]);
  await act(async () => useChatStore.getState().setCurrentThread('another-thread'));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});
