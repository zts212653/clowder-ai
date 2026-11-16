import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentBlocks } from '@/components/ContentBlocks';
import { ArtworkLightboxHost } from '@/components/content-review/ArtworkLightboxHost';
import { ArtworkLightboxProvider } from '@/components/content-review/ArtworkLightboxScope';
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

it('keeps the clicked unlinked-worktree gallery image and download working through the real ArtworkLightboxHost when resolve-file-source returns 404', async () => {
  const worktreeId = '09b32b_cat-planet-lookdev-rig-20261110';
  const imgPath = 'docs/evidence/2026-11-11-f329-game-look/graphics-switches-off-on.jpg';
  const rawUrl = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId, path: imgPath })}`;
  const coordPublication = {
    threadId: 'thread_owned_12f36a5ce1ccd054f12ecc7980ebbcf3f6af664f',
    messageId: '0001794401107691-000529-d99e68fd',
    messageRevision: '1',
  };
  useChatStore.setState({ currentThreadId: coordPublication.threadId, workspaceOpenRequest: null });
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/workspace/file?'))
      return new Response(JSON.stringify({ path: imgPath, mime: 'image/jpeg', binary: true, size: 389875 }));
    if (url === '/api/workspace/resolve-file-source')
      return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    if (url.startsWith('/api/workspace/file/download?'))
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error(`unexpected request: ${url}`);
  });

  await act(async () => {
    root.render(
      <ArtworkLightboxProvider threadId={coordPublication.threadId}>
        <MediaGalleryBlock
          publication={coordPublication}
          block={{ kind: 'media_gallery', v: 1, id: 'g1', items: [{ url: rawUrl, alt: '开关对照图' }] }}
        />
        <ArtworkLightboxHost />
      </ArtworkLightboxProvider>,
    );
  });

  const thumb = container.querySelector<HTMLButtonElement>('button[aria-label^="打开作品"]');
  expect(thumb).not.toBeNull();
  await act(async () => thumb!.click());

  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.querySelector('[data-testid="artwork-chat-preview"] img')?.getAttribute('src')).toBe(
    `http://api.test${rawUrl}`,
  );
  const fallback = dialog?.querySelector('[data-testid="artwork-preview-fallback"]');
  expect(fallback?.textContent).toContain('无法批注');

  const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://api.test/downloaded');
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const downloadBtn = dialog?.querySelector<HTMLButtonElement>('button[aria-label="下载"]');
  expect(downloadBtn).not.toBeNull();
  await act(async () => downloadBtn!.click());
  expect(mocks.apiFetch.mock.calls.some(([called]) => String(called).startsWith('/api/workspace/file/download?'))).toBe(
    true,
  );
  expect(anchorClick).toHaveBeenCalledOnce();
  createObjectUrl.mockRestore();
  revokeObjectUrl.mockRestore();
  anchorClick.mockRestore();
});

it('removes the floating preview through ArtworkLightboxHost when resolve-file-source returns 403 access_denied', async () => {
  const rawUrl = '/api/workspace/file/raw?worktreeId=revoked-wt&path=art/secret.jpg';
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/workspace/file?'))
      return new Response(JSON.stringify({ path: 'art/secret.jpg', mime: 'image/jpeg', binary: true, size: 1024 }));
    if (url === '/api/workspace/resolve-file-source')
      return new Response(JSON.stringify({ error: { code: 'access_denied' } }), { status: 403 });
    throw new Error(`unexpected request: ${url}`);
  });

  await act(async () => {
    root.render(
      <ArtworkLightboxProvider threadId={publication.threadId}>
        <MediaGalleryBlock
          publication={publication}
          block={{ kind: 'media_gallery', v: 1, id: 'g2', items: [{ url: rawUrl, alt: '受限图片' }] }}
        />
        <ArtworkLightboxHost />
      </ArtworkLightboxProvider>,
    );
  });

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="打开作品"]')!.click());

  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.querySelector('[data-testid="artwork-chat-preview"]')).toBeNull();
  expect(dialog?.querySelector('[data-testid="artwork-lightbox-owner"] [role="alert"]')?.textContent).toContain(
    '无权访问',
  );
});

it('unmounts a previously loaded floating preview when a linked directory is revoked before source resolution completes (404 not_found + /file 404)', async () => {
  const rawUrl = '/api/workspace/file/raw?worktreeId=linked_review&path=picture.png';
  let revoked = false;
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/workspace/file?')) {
      if (revoked) return new Response(JSON.stringify({ error: 'Unknown worktreeId: linked_review' }), { status: 404 });
      revoked = true; // Directory grant removed right after Stage 1 read, before Stage 2 resolve-file-source.
      return new Response(JSON.stringify({ path: 'picture.png', mime: 'image/png', binary: true, size: 68 }));
    }
    if (url === '/api/workspace/resolve-file-source')
      return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    throw new Error(`unexpected request: ${url}`);
  });

  await act(async () => {
    root.render(
      <ArtworkLightboxProvider threadId={publication.threadId}>
        <MediaGalleryBlock
          publication={publication}
          block={{ kind: 'media_gallery', v: 1, id: 'g-revoked', items: [{ url: rawUrl, alt: '已撤销目录图片' }] }}
        />
        <ArtworkLightboxHost />
      </ArtworkLightboxProvider>,
    );
  });

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="打开作品"]')!.click());

  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.querySelector('[data-testid="artwork-chat-preview"]')).toBeNull();
  expect(dialog?.querySelector('button[aria-label="下载"]')).toBeNull();
  expect(dialog?.querySelector('[data-testid="artwork-lightbox-owner"] [role="alert"]')?.textContent).toContain(
    '不可读取',
  );
});

it('refuses to keep an early floating preview open when a linked directory was already revoked before clicking (/file 404)', async () => {
  const rawUrl = '/api/workspace/file/raw?worktreeId=linked_review&path=picture.png';
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/workspace/file?'))
      return new Response(JSON.stringify({ error: 'Unknown worktreeId: linked_review' }), { status: 404 });
    throw new Error(`unexpected request: ${url}`);
  });

  await act(async () => {
    root.render(
      <ArtworkLightboxProvider threadId={publication.threadId}>
        <MediaGalleryBlock
          publication={publication}
          block={{ kind: 'media_gallery', v: 1, id: 'g-revoked-early', items: [{ url: rawUrl, alt: '已断开图片' }] }}
        />
        <ArtworkLightboxHost />
      </ArtworkLightboxProvider>,
    );
  });

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="打开作品"]')!.click());

  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('不可读取');
});
