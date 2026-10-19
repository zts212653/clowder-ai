import type { MediaContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtworkGalleryScope } from '@/components/content-review/ArtworkGalleryScope';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { mediaView, reviewId, revision } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

const THREAD = 'thread-ordinary-media';
let container: HTMLDivElement;
let root: Root;

const originalGallery = {
  index: 0,
  onSelect: () => {},
  items: [0, 1].map((index) => ({
    url: `/original-${index}.png`,
    title: `original-${index}.png`,
    alt: '',
    mediaType: 'image' as const,
    origin: {
      threadId: THREAD,
      messageId: 'same-original-message',
      messageRevision: '7',
      item: { kind: 'media-gallery' as const, blockId: 'group', itemIndex: index },
      index,
      count: 2,
    },
  })),
};
const mount = async (
  view = mediaView(),
  gallery = false,
  reference?: { attachment: MediaContextAttachment; selectionId?: string },
) => {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (
      url === '/api/workspace/content-reviews/prepare' ||
      (reference && url === `/api/workspace/content-reviews/${reviewId}`)
    )
      return new Response(JSON.stringify(view));
    throw new Error(`unexpected route: ${url}`);
  });
  await act(async () => {
    root.render(
      <ArtworkGalleryScope gallery={gallery ? originalGallery : undefined} reference={reference}>
        <WorkspaceContentReviewSurface
          worktreeId="worktree-a"
          path="cover.png"
          sourceText=""
          sourceTextRevision=""
          onBack={vi.fn()}
        />
      </ArtworkGalleryScope>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
};
const byText = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(label));
const selectWholeImage = async () => {
  const circle = byText('圈选');
  if (!circle) {
    await act(async () => byText('标注整张图片')?.click());
    return;
  }
  if (circle.getAttribute('aria-pressed') !== 'true') await act(async () => circle.click());
  const stage = container.querySelector<HTMLElement>('[data-testid="review-media-stage"]')!;
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 160,
    bottom: 100,
    width: 160,
    height: 100,
    toJSON: () => ({}),
  });
  const overlay = container.querySelector<SVGSVGElement>('[aria-label="图片或视频上的批注"]')!;
  overlay.setPointerCapture = vi.fn();
  overlay.hasPointerCapture = () => false;
  for (const [name, x, y] of [
    ['pointerdown', 0, 0],
    ['pointermove', 160, 100],
    ['pointerup', 160, 100],
  ] as const) {
    const event = new MouseEvent(name, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    await act(async () => {
      overlay.dispatchEvent(event);
    });
  }
};
const addToChat = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="workspace-content-review-media-add-to-chat"]');
const queued = () => useChatStore.getState().pendingChatInsert;
const queuedMedia = () =>
  (queued()?.contextAttachments ?? []).find((item): item is MediaContextAttachment => item.kind === 'media');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.apiFetch.mockReset();
  syncContextAttachmentDraftToStorage(THREAD, []);
  useChatStore.setState({ currentThreadId: THREAD, pendingChatInsert: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  writeShellPresentation('classic');
});

it('puts a native image region directly into the same Chat without another input or write', async () => {
  await mount();
  await selectWholeImage();
  expect(container.querySelector('textarea')).toBeNull();

  const attachment = queuedMedia();
  expect(queued()?.threadId).toBe(THREAD);
  expect(attachment).toMatchObject({
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    // The same source "请猫修改" names: the version that was reviewed, never a screenshot or a guessed Task.
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'worktree-a', path: 'cover.png' },
      expectedSourceRevision: revision,
      reviewId,
    },
    selections: [
      {
        id: '1',
        selection: { kind: 'image-region', x: 0, y: 0, width: 160, height: 100 },
      },
    ],
  });
  // Adding is not sending and not saving a review comment: nothing was written to the review.
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  // The words and the selection belong to the chip now: the form is empty and there is nothing left to add.
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '').toBe('');
  expect(addToChat()).toBeNull();
});

it('offers it only when there is a circled place to add', async () => {
  await mount();
  expect(addToChat()).toBeNull();
});

it('says another work already waits in the composer, and adds nothing', async () => {
  syncContextAttachmentDraftToStorage(THREAD, [
    {
      v: 1,
      id: 'media-other',
      kind: 'media',
      title: 'other.png',
      mediaType: 'image/png',
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'worktree-a', path: 'other.png' },
        expectedSourceRevision: revision,
        reviewId: 'other-review',
        expectedReviewRevision: 1,
      },
      selections: [{ id: '1', selection: { kind: 'image-point', x: 1, y: 1 } }],
    },
  ]);
  await mount();
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  expect(container.textContent).toContain('输入框里已有另一幅作品的选区');
  expect(queued()).toBeNull();
  // The circle and the words are kept so nothing the person did is lost.
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.querySelector('[aria-label="图片或视频上的批注"] rect')).not.toBeNull();
});

it('says there is no conversation to add it to when none is open', async () => {
  useChatStore.setState({ currentThreadId: undefined });
  await mount();
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  expect(container.textContent).toContain('请先打开一个对话');
  expect(queued()).toBeNull();
});

it.each([
  'image/jpeg',
  'image/webp',
] as const)('keeps the actual %s MIME and original source in the circled Chat place', async (mime) => {
  const image = mediaView();
  (image.review.source as { mime: string }).mime = mime;
  await mount(image);
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  expect(queuedMedia()).toMatchObject({
    mediaType: mime,
    source: { kind: 'workspace', expectedSourceRevision: revision, reviewId },
    selections: [{ selection: { kind: 'image-region', x: 0, y: 0, width: 160, height: 100 } }],
  });
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
});

it('refuses an unadmitted GIF without putting a misleading image into Chat', async () => {
  const image = mediaView();
  (image.review.source as { mime: string }).mime = 'image/gif';
  await mount(image);
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  expect(queued()).toBeNull();
});

it('does not draw places that belong to another work onto this picture', async () => {
  syncContextAttachmentDraftToStorage(THREAD, [
    {
      v: 1,
      id: 'media-other',
      kind: 'media',
      title: 'other.png',
      mediaType: 'image/png',
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'worktree-a', path: 'other.png' },
        expectedSourceRevision: revision,
        reviewId: 'other-review',
        expectedReviewRevision: 1,
      },
      selections: [{ id: '1', selection: { kind: 'image-point', x: 1, y: 1 } }],
    },
  ]);
  await mount();
  expect(container.querySelectorAll('[data-testid="review-pending-chat-mark"]')).toHaveLength(0);
});

it('marks the circled place on the picture with the number it has in the composer, until it is sent', async () => {
  await mount();
  expect(container.querySelectorAll('[data-testid="review-pending-chat-mark"]')).toHaveLength(0);
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  // The composer takes the queued insert; here the draft is stored the way it would be.
  const attachment = queuedMedia() as MediaContextAttachment;
  await act(async () => {
    syncContextAttachmentDraftToStorage(THREAD, [attachment]);
    useChatStore.getState().setPendingChatInsert(null);
  });
  const marks = [...container.querySelectorAll('[data-testid="review-pending-chat-mark"]')];
  expect(marks.map((mark) => mark.textContent)).toEqual(['1']);
  // Sent or removed: the marks go with the chip.
  await act(async () => syncContextAttachmentDraftToStorage(THREAD, []));
  expect(container.querySelectorAll('[data-testid="review-pending-chat-mark"]')).toHaveLength(0);
});

it('puts the brush next to the image and keeps the only ordinary input in Chat', async () => {
  await mount();
  await act(async () => byText('画笔')?.click());
  expect(container.querySelector('[data-testid="review-markup-layer"]')).not.toBeNull();
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.querySelector('[aria-label="图片更多操作"]')).not.toBeNull();
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
});

it('keeps per-place gallery words in the one original draft and Enter retains them', async () => {
  writeShellPresentation('v2');
  await mount(mediaView(), true);
  await selectWholeImage();
  expect(queuedMedia()?.selections).toHaveLength(1);
  const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="这处的话"]');
  expect(editor).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '只改图一这处');
    editor!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(queuedMedia()?.selections[0]?.instruction).toBe('只改图一这处');
  await act(async () =>
    editor!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })),
  );
  expect(container.querySelector('textarea[aria-label="这处的话"]')).toBe(editor);
  await act(async () => editor!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(container.querySelector('textarea[aria-label="这处的话"]')).toBeNull();
  expect(queuedMedia()?.selections[0]?.instruction).toBe('只改图一这处');
});

it('Escape cancels only the newly captured gallery place and preserves a sibling work', async () => {
  writeShellPresentation('v2');
  await mount(mediaView(), true);
  await selectWholeImage();
  const captured = queuedMedia()!;
  if (captured.source.kind !== 'workspace') throw new Error('Expected workspace fixture');
  const sibling: MediaContextAttachment = {
    ...captured,
    id: 'sibling',
    source: { ...captured.source, reviewId: 'other-review' },
    gallery: { ...originalGallery.items[1].origin },
    selections: [{ id: '2', selection: { kind: 'image-point', x: 1, y: 1 }, instruction: '保留图二' }],
  };
  await act(async () => syncContextAttachmentDraftToStorage(THREAD, [sibling]));
  const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="这处的话"]');
  expect(editor).not.toBeNull();
  await act(async () => editor!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('textarea[aria-label="这处的话"]')).toBeNull();
  const queuedAttachments = queued()?.contextAttachments ?? [];
  expect(queuedAttachments.some((item) => item.id === captured.id)).toBe(false);
  expect(queued()?.removeContextAttachmentIds).toContain(captured.id);
  expect(getContextAttachmentDraft(THREAD).find((item) => item.id === sibling.id)).toEqual(sibling);

  expect(useChatStore.getState().currentThreadId).toBe(THREAD);
});

it('does not interpret an IME Escape as cancellation of a gallery place', async () => {
  writeShellPresentation('v2');
  await mount(mediaView(), true);
  await selectWholeImage();
  const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="这处的话"]')!;
  expect(editor).not.toBeNull();
  await act(async () =>
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })),
  );
  expect(container.querySelector('textarea[aria-label="这处的话"]')).toBe(editor);
  expect(queuedMedia()?.selections).toHaveLength(1);
});

it('reopens a sent gallery place on the exact retained owner read and highlights it without inserting a new draft', async () => {
  writeShellPresentation('v2');
  const attachment: MediaContextAttachment = {
    v: 1,
    id: 'sent-image',
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'worktree-a', path: 'cover.png' },
      reviewId,
      expectedReviewRevision: 1,
      expectedSourceRevision: revision,
    },
    gallery: originalGallery.items[0].origin,
    selections: [
      { id: '9', selection: { kind: 'image-region', x: 10, y: 20, width: 30, height: 40 }, instruction: '只改这里' },
    ],
  };
  await mount(mediaView(), true, { attachment, selectionId: '9' });
  expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe(`/api/workspace/content-reviews/${reviewId}`);
  expect(
    container
      .querySelector('[data-testid="review-pending-chat-mark"][data-selection-id="9"]')
      ?.getAttribute('data-active'),
  ).toBe('true');
  expect(queued()).toBeNull();
  expect(getContextAttachmentDraft(THREAD)).toEqual([]);
});
