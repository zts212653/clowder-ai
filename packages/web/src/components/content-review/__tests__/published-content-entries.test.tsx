import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentBlocks } from '@/components/ContentBlocks';
import { FileBlock } from '@/components/rich/FileBlock';
import { MediaGalleryBlock } from '@/components/rich/MediaGalleryBlock';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createPublicationSurface } from '@/components/workbench/publication-surface';
import { projectCanonicalBubbles } from '@/stores/bubble-projection';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
const publication = { threadId: 'source-thread', messageId: 'source-message', messageRevision: '12' };
const asset = {
  contentRef: `prepared-media:${'c'.repeat(64)}`,
  ownerRevision: 1,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 160, height: 100 },
  sourcePublication: {
    artifactRef: '/uploads/a.png',
    sourceRef: 'message:source-thread:source-message',
    revision: '12',
  },
  ownerReceiptRef: 'receipt',
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.apiFetch.mockReset();
  localStorage.clear();
  mocks.apiFetch.mockResolvedValue(
    new Response(JSON.stringify({ status: 'resolved', ownerUserId: 'operator', asset })),
  );
  useChatStore.setState({ currentThreadId: 'host-thread', workspaceOpenRequest: null });
  useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it.each([
  'gallery',
  'content-block',
  'rich-file',
] as const)('%s opens exact publication in right Workspace, without a lightbox or download', async (kind) => {
  await act(async () => {
    root.render(
      kind === 'gallery' ? (
        <MediaGalleryBlock
          publication={publication}
          block={{ kind: 'media_gallery', v: 1, id: 'gallery', items: [{ url: '/uploads/a.png' }] }}
        />
      ) : kind === 'content-block' ? (
        <ContentBlocks
          publication={publication}
          blocks={[{ type: 'file', url: '/uploads/a.mp4', fileName: '片段.mp4', mimeType: 'video/mp4', fileSize: 24 }]}
        />
      ) : (
        <FileBlock
          publication={publication}
          block={{ kind: 'file', v: 1, id: 'file', url: '/uploads/a.mp4', fileName: '片段.mp4' }}
        />
      ),
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button')!.click();
  });
  const [url, init] = mocks.apiFetch.mock.calls[0]!;
  expect(url).toBe('/api/content-publications/resolve');
  const selector =
    kind === 'gallery'
      ? { kind: 'media-gallery', blockId: 'gallery', itemIndex: 0 }
      : kind === 'content-block'
        ? { kind: 'content-block', index: 0 }
        : { kind: 'rich-file', blockId: 'file' };
  expect(JSON.parse(init.body).source).toEqual({
    kind: 'message',
    ...publication,
    item: selector,
    expectedUrl: kind === 'gallery' ? '/uploads/a.png' : '/uploads/a.mp4',
  });
  expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
    kind: 'publication',
    contentRef: asset.contentRef,
    ownerRevision: 1,
    messagePublicationSource: JSON.parse(init.body).source,
  });
  const target = useChatStore.getState().workspaceOpenRequest?.target;
  if (target?.kind !== 'publication') throw Error('missing canonical publication');
  expect(createPublicationSurface(target).messagePublicationSource).toEqual(JSON.parse(init.body).source);
  expect(useChatStore.getState().rightPanelMode).toBe('workspace');
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  expect(container.querySelector('a[download]')).toBeNull();
});

it('clicking a later folded attachment submits its original message coordinate and returns to that source', async () => {
  const first: ChatMessage = {
    id: 'first',
    type: 'assistant',
    catId: 'codex-astra',
    origin: 'stream',
    content: 'one',
    timestamp: 10,
    contentBlocks: [{ type: 'image', url: '/uploads/a.png' }],
    extra: { stream: { invocationId: 'inv' } },
  };
  const second: ChatMessage = {
    ...first,
    id: 'second',
    content: 'two',
    timestamp: 20,
    contentBlocks: [{ type: 'file', url: '/uploads/b.mp4', fileName: 'b.mp4', mimeType: 'video/mp4', fileSize: 24 }],
  };
  const bubble = projectCanonicalBubbles({ records: [first, second] }).messages[0]!;
  await act(async () =>
    root.render(
      <ContentBlocks
        blocks={bubble.contentBlocks!}
        publication={{
          threadId: 'source-thread',
          messageId: bubble.id,
          messageRevision: String(bubble.timestamp),
          origins: bubble.projectionPublicationOrigins,
        }}
      />,
    ),
  );
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('b.mp4'))!;
  await act(async () => button.click());
  expect(JSON.parse(mocks.apiFetch.mock.calls[0]![1].body).source).toEqual({
    kind: 'message',
    threadId: 'source-thread',
    messageId: 'second',
    messageRevision: '20',
    item: { kind: 'content-block', index: 0 },
    expectedUrl: '/uploads/b.mp4',
  });
  expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
    navigationOrigin: { kind: 'chat-file-link', threadId: 'source-thread', messageId: 'second' },
  });
});

it('a delayed publication response cannot open into a newly selected conversation', async () => {
  let finish!: (value: Response) => void;
  mocks.apiFetch.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    root.render(<ContentBlocks publication={publication} blocks={[{ type: 'image', url: '/uploads/a.png' }]} />);
  });
  await act(async () => {
    container.querySelector('img')!.click();
  });
  useChatStore.setState({ currentThreadId: 'different-thread' });
  await act(async () => {
    finish(new Response(JSON.stringify({ status: 'resolved', ownerUserId: 'operator', asset })));
  });
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('对话已切换');
});

it('an ambiguous source opens a resolving Workspace surface instead of silently selecting or failing the chat entry', async () => {
  mocks.apiFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'choice-required',
        ownerUserId: 'operator',
        choices: [
          {
            asset,
            title: '封面',
            taskTitle: '原委托',
            threadTitle: '画画',
            match: 'legacy-ambiguous',
          },
        ],
      }),
    ),
  );
  await act(async () =>
    root.render(<ContentBlocks publication={publication} blocks={[{ type: 'image', url: '/uploads/a.png' }]} />),
  );
  await act(async () => container.querySelector('img')!.click());
  expect(useChatStore.getState().workspaceOpenRequest?.target.kind).toBe('message-publication');
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
});
