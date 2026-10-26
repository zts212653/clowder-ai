import type { MediaContextAttachment, WorkspaceContentReviewView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { useChatStore } from '@/stores/chatStore';
import { ContentBlocks } from '../ContentBlocks';
import { ContextAttachmentList } from '../ContextAttachmentView';
import { videoDiscussionView } from '../workbench/content-review/__tests__/WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: mocks.apiFetch }));

function fixture(): { attachment: MediaContextAttachment; view: WorkspaceContentReviewView } {
  const view = videoDiscussionView();
  if (view.review.source.kind !== 'media' || view.review.source.media.kind !== 'video') throw new Error('fixture');
  view.review.source.media.timebase = { numerator: 1, denominator: 15360 };
  view.review.source.media.durationTicks = 15360 * 300;
  return {
    view,
    attachment: {
      v: 1,
      kind: 'media',
      id: 'same-film',
      title: '人还剩什么？ v3.1',
      mediaType: 'video/mp4',
      source: {
        kind: 'workspace',
        locator: view.review.source.locator,
        reviewId: view.review.reviewId,
        expectedReviewRevision: 1,
        expectedSourceRevision: view.review.source.revision,
      },
      gallery: {
        threadId: 'thread',
        messageId: 'original',
        messageRevision: '12',
        item: { kind: 'content-block', index: 0 },
        index: 0,
        count: 1,
      },
      selections: [82, 110, 164].map((seconds, index) => ({
        id: String(index + 1),
        instruction: ['这只猫的表情再明显一点', '报告标题停留久一点', '这里的画面再亮一点'][index],
        selection: {
          kind: 'video-range',
          streamId: 'ordinary-video-stream',
          startTick: (seconds - 2) * 15360,
          endTick: (seconds + 1) * 15360,
          frameRegion: { tick: seconds * 15360, x: 20 + index * 10, y: 15, width: 40, height: 30 },
        },
      })),
    },
  };
}
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify(fixture().view)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mocks.apiFetch.mockReset();
});

it('reopens a Works-origin place without inventing a gallery or a new publication, retaining the exact opinion source', async () => {
  const { attachment } = fixture();
  delete attachment.gallery;
  useChatStore.setState({ currentThreadId: 'thread', messages: [], pendingChatInsert: null });
  function Opened() {
    const scope = useArtworkLightboxScope();
    return <output data-testid="opened" data-reference={JSON.stringify(scope?.work?.reference)} />;
  }
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="thread">
        <ContentBlocks
          blocks={[{ type: 'context_attachment', attachment }]}
          messageSource={{ threadId: 'thread', messageId: 'opinion' }}
        />
        <Opened />
      </ArtworkLightboxProvider>,
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="打开图 1 · 第 2 处"]')?.click());
  const reference = JSON.parse(
    container.querySelector('[data-testid="opened"]')?.getAttribute('data-reference') ?? 'null',
  );
  expect(reference).toMatchObject({
    attachment: { source: attachment.source },
    selectionId: '2',
    origin: { kind: 'message', threadId: 'thread', messageId: 'opinion' },
  });
  expect(mocks.apiFetch.mock.calls.every(([url]) => !String(url).includes('/prepare'))).toBe(true);
});

it('keeps the full comment and selected-frame time in the focus preview, while chips show only the comment', async () => {
  const { attachment } = fixture();
  attachment.selections[0].instruction = '这一处的话超过十六个字仍然可以在预览中读到完整内容';
  await act(async () => root.render(<ContextAttachmentList attachments={[attachment]} compact onRemove={vi.fn()} />));
  expect(container.textContent).toContain(`${Array.from(attachment.selections[0].instruction).slice(0, 16).join('')}…`);
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="打开图 1 · 第 1 处"]')!;
  const originalMatches = Element.prototype.matches;
  const focusVisible = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ':focus-visible' ? this === button : originalMatches.call(this, selector);
  });
  await act(async () => button.focus());
  const tip = document.querySelector('[role="tooltip"]');
  expect(tip?.textContent).toContain('1:22 · 人还剩什么？ v3.1');
  expect(tip?.textContent).toContain(attachment.selections[0].instruction);
  expect(tip?.querySelector('video')?.src).toBe(container.querySelector('video')?.src);
  focusVisible.mockRestore();
});

it('does not refetch the immutable clock when the person edits a comment, or accept a late read for a changed source', async () => {
  const { attachment, view } = fixture();
  let finish: ((response: Response) => void) | undefined;
  mocks.apiFetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const render = async (value: MediaContextAttachment) =>
    act(async () => root.render(<ContextAttachmentList attachments={[value]} compact onRemove={vi.fn()} />));
  await render(attachment);
  await render({
    ...attachment,
    selections: attachment.selections.map((place) => ({ ...place, instruction: '改了这句话' })),
  });
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  const oldRead = finish;
  await render({
    ...attachment,
    source: {
      ...attachment.source,
      expectedSourceRevision: `sha256:${'d'.repeat(64)}`,
    } as MediaContextAttachment['source'],
  });
  await act(async () => oldRead?.(new Response(JSON.stringify(view))));
  expect(container.querySelector('video')).toBeNull();
  await act(async () => finish?.(new Response(JSON.stringify(view))));
  expect(container.querySelector('video')).toBeNull();
});

it('shows each selected original frame in composer and sent rows, using the owner clock rather than milliseconds', async () => {
  const { attachment } = fixture();
  for (const compact of [true, false]) {
    await act(async () =>
      root.render(
        compact ? (
          <ContextAttachmentList attachments={[attachment]} compact onRemove={vi.fn()} />
        ) : (
          <ContentBlocks blocks={[{ type: 'context_attachment', attachment }]} />
        ),
      ),
    );
    const videos = [...container.querySelectorAll('video')];
    expect(videos).toHaveLength(3);
    await act(async () =>
      videos.forEach((video) => {
        Object.defineProperties(video, {
          readyState: { configurable: true, value: 2 },
          videoWidth: { value: 320 },
          videoHeight: { value: 200 },
        });
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('seeked'));
      }),
    );
    expect(videos.map((video) => video.currentTime)).toEqual([82, 110, 164]);
    expect(
      [...container.querySelectorAll('[data-testid="media-selection-preview"] svg[viewBox]')].map((node) =>
        node.getAttribute('viewBox'),
      ),
    ).toEqual(['0 0 160 100', '0 0 160 100', '0 0 160 100']);
    expect(container.textContent).toContain('人还剩什么？ v3.1');
    expect(container.textContent).not.toContain('Artwork 1');
    expect(container.textContent).not.toMatch(/\d+\s*(s|秒)/);
    expect(
      [...container.querySelectorAll('[data-testid="media-selection-number"]')].map((node) => node.textContent),
    ).toEqual(['1', '2', '3']);
    expect([...container.querySelectorAll('svg rect')].map((node) => node.getAttribute('x'))).toEqual([
      '20',
      '30',
      '40',
    ]);
    expect(
      videos.every(
        (video) =>
          new URL(video.src).searchParams.get('expectedSourceRevision') ===
          (attachment.source.kind === 'workspace' ? attachment.source.expectedSourceRevision : 'unreachable'),
      ),
    ).toBe(true);
  }
});

it('does not seek or paint a stored selection using metadata from a different video stream', async () => {
  const { attachment, view } = fixture();
  if (view.review.source.kind !== 'media' || view.review.source.media.kind !== 'video') throw new Error('fixture');
  view.review.source.media.streamId = 'another-stream';
  mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify(view)));
  await act(async () => root.render(<ContextAttachmentList attachments={[attachment]} compact onRemove={vi.fn()} />));
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelector('svg rect')).toBeNull();
  expect(container.textContent).toMatch(/预览|Preview/);
  expect(container.textContent).toContain('报告标题停留久一点');
});
