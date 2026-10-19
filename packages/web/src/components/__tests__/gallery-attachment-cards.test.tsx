import type { MediaContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { ContentBlocks } from '../ContentBlocks';
import { ContextAttachmentList } from '../ContextAttachmentView';
import {
  mediaView,
  reviewId,
  revision,
} from '../workbench/content-review/__tests__/WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
const THREAD = 'gallery-card-thread';
const attachment = (index: number): MediaContextAttachment => ({
  v: 1,
  kind: 'media',
  id: `picture-${index}`,
  title: `图片${index + 1}.png`,
  mediaType: 'image/png',
  source: {
    kind: 'workspace',
    locator: { worktreeId: 'worktree-a', path: 'cover.png' },
    reviewId,
    expectedReviewRevision: 1,
    expectedSourceRevision: revision,
  },
  gallery: {
    threadId: THREAD,
    messageId: 'original',
    messageRevision: '12',
    item: { kind: 'content-block', index },
    index,
    count: 2,
  },
  selections: [
    {
      id: String(index + 3),
      selection: { kind: 'image-region', x: 1, y: 2, width: 4, height: 5 },
      instruction: `只改图${index + 1}`,
    },
  ],
});
function Probe() {
  const scope = useArtworkLightboxScope();
  return (
    <>
      <button type="button" data-testid="close-presentation" onClick={scope?.close}>
        关闭
      </button>
      <output
        data-testid="opened"
        data-index={scope?.work?.gallery?.index}
        data-place={scope?.work?.reference?.selectionId}
      >
        {scope?.work?.title}
      </output>
    </>
  );
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  writeShellPresentation('v2');
  useChatStore.setState({ currentThreadId: THREAD, messages: [], pendingChatInsert: null });
  mocks.apiFetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.startsWith('/api/messages?')
            ? {
                messages: [
                  {
                    id: 'original',
                    timestamp: 12,
                    contentBlocks: [
                      { type: 'image', url: '/uploads/a.png' },
                      { type: 'image', url: '/uploads/b.png' },
                    ],
                  },
                ],
              }
            : mediaView(),
        ),
      ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mocks.apiFetch.mockReset();
  writeShellPresentation('classic');
});
async function render(compact = false, items = [attachment(0), attachment(1)]) {
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId={THREAD}>
        <textarea id="chat-message-input" defaultValue="原来的话" />
        <ContextAttachmentList attachments={items} compact={compact} onRemove={compact ? vi.fn() : undefined} />
        <Probe />
      </ArtworkLightboxProvider>,
    ),
  );
}
it('sends one grouped gallery with two original image cards, words, continuous numbers and exact-place buttons', async () => {
  await render();
  expect(container.querySelectorAll('[data-testid="gallery-message-group"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="gallery-work-card"]')).toHaveLength(2);
  expect(container.textContent).toContain('2 张图 · 2 处');
  expect(container.querySelector('button[aria-label="打开图 2 · 第 4 处"]')).not.toBeNull();
});
it('a restored composer tag reopens its original image and place without replacing the physical composer', async () => {
  await render(true);
  const composer = container.querySelector('textarea');
  const tag = container.querySelector<HTMLButtonElement>('button[aria-label="打开图 2 · 第 4 处"]');
  expect(tag).not.toBeNull();
  await act(async () => tag!.click());
  expect(container.querySelector('[data-testid="opened"]')?.getAttribute('data-index')).toBe('1');
  expect(container.querySelector('[data-testid="opened"]')?.getAttribute('data-place')).toBe('4');
  expect(mocks.apiFetch.mock.calls.some(([url]) => url === `/api/workspace/content-reviews/${reviewId}`)).toBe(true);
  expect(mocks.apiFetch.mock.calls.some(([url]) => url.includes('/prepare'))).toBe(false);
  expect(container.querySelector('textarea')).toBe(composer);
  expect(composer?.value).toBe('原来的话');
});
it('never overlays a stored circle onto changed workspace bytes or guesses another source message', async () => {
  const changed = { ...mediaView(), sourceState: 'changed' as const };
  mocks.apiFetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.startsWith('/api/messages?')
            ? {
                messages: [
                  {
                    id: 'original',
                    timestamp: 12,
                    contentBlocks: [
                      { type: 'image', url: '/uploads/a.png' },
                      { type: 'image', url: '/uploads/b.png' },
                    ],
                  },
                ],
              }
            : changed,
        ),
      ),
  );
  await render(true);
  const tag = container.querySelector<HTMLButtonElement>('button[aria-label="打开图 2 · 第 4 处"]');
  expect(tag).not.toBeNull();
  await act(async () => tag!.click());
  expect(container.querySelector('[data-testid="opened"]')?.textContent).toBe('');
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/原版|版本/);
});

it('renders the actual sent blocks as one gallery, with the Human body once and exact owner thumbnails', async () => {
  const works = [attachment(0), attachment(1)];
  await act(async () =>
    root.render(
      <ContentBlocks
        blocks={[
          { type: 'text', text: '只说一次' },
          ...works.map((item) => ({ type: 'context_attachment' as const, attachment: item })),
        ]}
      />,
    ),
  );
  expect(container.textContent?.split('只说一次')).toHaveLength(2);
  expect(container.querySelectorAll('[data-testid="gallery-message-group"]')).toHaveLength(1);
  const previews = [...container.querySelectorAll('img')];
  expect(previews).toHaveLength(2);
  expect(previews.every((image) => new URL(image.src).searchParams.get('expectedSourceRevision') === revision)).toBe(
    true,
  );
  // Browser layout is checked by the production journey; this covers the asynchronous
  // decode-to-overlay boundary that the former DOM-only thumbnail assertion missed.
  expect(container.querySelectorAll('[data-testid="review-pending-chat-mark"]')).toHaveLength(0);
  await act(async () => {
    for (const image of previews) {
      Object.defineProperties(image, { naturalWidth: { value: 1440 }, naturalHeight: { value: 900 } });
      image.dispatchEvent(new Event('load'));
    }
  });
  const rows = [...container.querySelectorAll('[data-testid="gallery-work-card"]')];
  expect(
    rows.map((row) => row.querySelector('[data-testid="review-pending-chat-mark"]')?.getAttribute('data-selection-id')),
  ).toEqual(['3', '4']);
  expect(rows.map((row) => row.querySelector('svg')?.getAttribute('viewBox'))).toEqual([
    '0 0 1440 900',
    '0 0 1440 900',
  ]);
});
it('keeps thumbnail numbers readable in screen pixels when the original and preview sizes differ', async () => {
  let notifyResize: ResizeObserverCallback | undefined;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  try {
    const original = attachment(0);
    await render(false, [
      {
        ...original,
        selections: [
          { ...original.selections[0], selection: { kind: 'image-region', x: 1400, y: 880, width: 40, height: 20 } },
        ],
      },
    ]);
    const image = container.querySelector('img')!;
    let width = 128;
    Object.defineProperties(image, {
      naturalWidth: { value: 1440 },
      naturalHeight: { value: 900 },
      getBoundingClientRect: { value: () => ({ width, height: (width * 900) / 1440 }) },
    });
    await act(async () => image.dispatchEvent(new Event('load')));
    const assertReadable = () => {
      const mark = container.querySelector('[data-selection-id="3"]')!;
      const scale = width / 1440;
      expect(Number(mark.querySelector('circle')?.getAttribute('r')) * scale).toBeGreaterThanOrEqual(8);
      expect(Number(mark.querySelector('text')?.getAttribute('font-size')) * scale).toBeGreaterThanOrEqual(10);
      expect(mark.querySelector('text')?.textContent).toBe('3');
      expect(mark.querySelector('rect')?.getAttribute('x')).toBe('1400');
      expect(mark.querySelector('rect')?.getAttribute('width')).toBe('40');
      const circle = mark.querySelector('circle')!;
      expect(Number(circle.getAttribute('cx')) + Number(circle.getAttribute('r'))).toBeLessThanOrEqual(1440);
      expect(Number(circle.getAttribute('cy')) + Number(circle.getAttribute('r'))).toBeLessThanOrEqual(900);
    };
    assertReadable();
    width = 64;
    await act(async () => notifyResize?.([], {} as ResizeObserver));
    assertReadable();
  } finally {
    vi.unstubAllGlobals();
  }
});
it('a close while the original message read is pending prevents a late reopen', async () => {
  let answer: ((response: Response) => void) | undefined;
  mocks.apiFetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  await render(true);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="打开图 2 · 第 4 处"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="close-presentation"]')!.click());
  await act(async () =>
    answer!(
      new Response(
        JSON.stringify({
          messages: [
            {
              id: 'original',
              timestamp: 12,
              contentBlocks: [
                { type: 'image', url: '/uploads/a.png' },
                { type: 'image', url: '/uploads/b.png' },
              ],
            },
          ],
        }),
      ),
    ),
  );
  expect(container.querySelector('[data-testid="opened"]')?.textContent).toBe('');
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
});
it('cannot use an adjacent or edited message as the original gallery', async () => {
  mocks.apiFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        messages: [{ id: 'original', timestamp: 13, contentBlocks: [{ type: 'image', url: '/uploads/changed.png' }] }],
      }),
    ),
  );
  await render(true);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="打开图 2 · 第 4 处"]')!.click());
  expect(container.querySelector('[data-testid="opened"]')?.textContent).toBe('');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('原消息');
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
});
