import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentBlocks } from '@/components/ContentBlocks';
import { FileBlock } from '@/components/rich/FileBlock';
import { MediaGalleryBlock } from '@/components/rich/MediaGalleryBlock';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { openFileMenu } from '@/test-utils/open-file-menu';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
const publication = { threadId: 'host-thread', messageId: 'message-a', messageRevision: '12' };
const path = 'art/中文 %25.png';
const rawUrl = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: 'wt-a', path })}`;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  mocks.apiFetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ path, mime: 'image/png' })));
  useChatStore.setState({ currentThreadId: 'host-thread', workspaceOpenRequest: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

async function render(kind: 'gallery' | 'content-image' | 'content-video' | 'rich-video', url = rawUrl) {
  await act(async () => {
    root.render(
      kind === 'gallery' ? (
        <MediaGalleryBlock
          publication={publication}
          block={{ kind: 'media_gallery', v: 1, id: 'g', items: [{ url, alt: '作品' }] }}
        />
      ) : kind === 'rich-video' ? (
        <FileBlock
          publication={publication}
          block={{ kind: 'file', v: 1, id: 'f', url, fileName: '片段.mp4', mimeType: 'video/mp4' }}
        />
      ) : (
        <ContentBlocks
          publication={publication}
          blocks={
            kind === 'content-image'
              ? [{ type: 'image', url }]
              : [{ type: 'file', url, fileName: '片段.mp4', mimeType: 'video/mp4', fileSize: 24 }]
          }
        />
      ),
    );
  });
}

async function openExplicitWorkspace() {
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  const action = dialog?.querySelector<HTMLButtonElement>('[data-testid="lightbox-open-workspace"]');
  expect(action).toBeTruthy();
  await act(async () => action?.click());
}

it.each([
  'gallery',
  'content-image',
  'content-video',
  'rich-video',
] as const)('v2 %s verifies the raw file, floats it, and keeps its exact owner and Chat return for explicit Workspace', async (kind) => {
  await render(kind);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  const request = mocks.apiFetch.mock.calls.find(([url]) => String(url).startsWith('/api/workspace/file?'))?.[0];
  expect(request).toBe(`/api/workspace/file?${new URLSearchParams({ worktreeId: 'wt-a', path })}`);
  await openExplicitWorkspace();
  expect(useChatStore.getState().workspaceOpenRequest?.target).toEqual({
    kind: 'file',
    worktreeId: 'wt-a',
    path,
    navigationOrigin: { kind: 'chat-file-link', threadId: publication.threadId, messageId: publication.messageId },
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('accepts the configured API origin without treating another host as a local file', async () => {
  await render('gallery', `http://api.test${rawUrl}`);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  await openExplicitWorkspace();
  expect(useChatStore.getState().workspaceOpenRequest?.target.kind).toBe('file');
});

it.each([
  `https://other.test${rawUrl}`,
  '/api/workspace/file/raw?path=cover.png',
  '/api/workspace/file/raw?worktreeId=a&worktreeId=b&path=cover.png',
  '/api/workspace/file/raw?worktreeId=a&path=cover.png+',
])('unresolved %s previews with an honest annotation limitation', async (url) => {
  await render('gallery', url);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(
    mocks.apiFetch.mock.calls.filter(
      ([url]) => String(url).startsWith('/api/workspace/file?') || String(url) === '/api/content-publications/resolve',
    ),
  ).toEqual([]);
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('无法批注');
});

it('does not expose a cached preview after a denied file read', async () => {
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 }));
  await render('gallery');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('访问');
});

it('a delayed read cannot open into another conversation', async () => {
  let finish!: (response: Response) => void;
  mocks.apiFetch.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  await render('gallery');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  useChatStore.setState({ currentThreadId: 'another-thread' });
  await act(async () => finish(new Response(JSON.stringify({ path, mime: 'image/png' }))));
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('对话已切换');
});

it('a delayed failed read cannot open a fallback preview in another conversation', async () => {
  let finish!: (response: Response) => void;
  mocks.apiFetch.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  await render('gallery');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  useChatStore.setState({ currentThreadId: 'another-thread' });
  await act(async () => finish(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })));
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('classic raw galleries keep the same appearance and use the same authorized file owner', async () => {
  writeShellPresentation('classic');
  await render('gallery');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(mocks.apiFetch.mock.calls.some(([url]) => String(url).startsWith('/api/workspace/file?'))).toBe(true);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('无法批注');
});

it.each([
  'content-video',
  'rich-video',
] as const)('v2 unresolved %s opens a video preview with the limitation', async (kind) => {
  await render(kind, 'https://other.test/clip.mp4');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(
    mocks.apiFetch.mock.calls.filter(
      ([url]) => String(url).startsWith('/api/workspace/file?') || String(url) === '/api/content-publications/resolve',
    ),
  ).toEqual([]);
  expect(document.querySelector('[role="dialog"] video')?.getAttribute('src')).toBe('https://other.test/clip.mp4');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('无法批注');
});

it('a supported raw MP4 uses its workspace owner', async () => {
  mocks.apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ path: 'art/clip.mp4', mime: 'video/mp4' })),
  );
  const url = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: 'wt-a', path: 'art/clip.mp4' })}`;
  await render('rich-video', url);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  await openExplicitWorkspace();
  expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({ kind: 'file', path: 'art/clip.mp4' });
});

it.each([
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['ogg', 'audio/ogg'],
  ['flac', 'audio/flac'],
  ['pdf', 'application/pdf'],
  ['md', 'text/markdown'],
] as const)('v2 raw %s human and cat cards retain one shared download menu', async (ext, mimeType) => {
  const fileName = `材料.${ext}`;
  const filePath = `art/${fileName}`;
  const url = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: 'wt-a', path: filePath })}`;
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ path: filePath, mime: mimeType })));
  for (const kind of ['content', 'rich', 'rich-without-mime'] as const) {
    await act(async () => {
      root.render(
        kind === 'content' ? (
          <ContentBlocks blocks={[{ type: 'file', url, fileName, mimeType, fileSize: 24 }]} publication={publication} />
        ) : (
          <FileBlock
            block={{ kind: 'file', v: 1, id: 'f', url, fileName, ...(kind === 'rich' ? { mimeType } : {}) }}
            publication={publication}
          />
        ),
      );
    });
    const entry = container.querySelector<HTMLElement>('a[download], button');
    if (!entry) throw new Error(`missing ${kind} file entry`);
    entry.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await act(async () => entry.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await openFileMenu(container);
    const download = container.querySelector<HTMLAnchorElement>('a[download]');
    expect(download?.getAttribute('href')).toBe(
      `http://api.test${mimeType.startsWith('audio/') ? url : url.replace('/raw?', '/download?')}`,
    );
    expect(download?.getAttribute('download')).toBe(fileName);
    expect(
      mocks.apiFetch.mock.calls.filter(
        ([url]) =>
          String(url).startsWith('/api/workspace/file?') || String(url) === '/api/content-publications/resolve',
      ),
    ).toEqual([]);
    expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
      kind: 'file',
      path: filePath,
      worktreeId: 'wt-a',
    });
  }
});

it('an unsupported GIF previews without promising annotations', async () => {
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ path, mime: 'image/gif' })));
  await render('gallery');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('格式尚不支持');
});

it('a raw item folded from another message returns to that original message', async () => {
  const folded = {
    ...publication,
    origins: {
      'gallery:g:0': {
        messageId: 'original',
        messageRevision: '10',
        item: { kind: 'media-gallery' as const, blockId: 'original-g', itemIndex: 0 },
      },
    },
  };
  await act(async () =>
    root.render(
      <MediaGalleryBlock
        publication={folded}
        block={{ kind: 'media_gallery', v: 1, id: 'g', items: [{ url: rawUrl }] }}
      />,
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  await openExplicitWorkspace();
  const target = useChatStore.getState().workspaceOpenRequest?.target;
  expect(target?.kind).toBe('file');
  if (target?.kind !== 'file') throw new Error('missing workspace owner');
  expect(target.navigationOrigin).toMatchObject({
    messageId: 'original',
  });
});
