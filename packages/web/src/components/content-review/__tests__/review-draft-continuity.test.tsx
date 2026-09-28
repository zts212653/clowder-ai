import type { ArtifactReviewRound } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReviewComments } from '../ReviewComments';
import { ReviewReply } from '../ReviewReply';
import { startReviewReanchor } from '../startReviewReanchor';

vi.mock('../ReviewActor', () => ({ ReviewActor: () => createElement('span', null, 'You') }));
const round: ArtifactReviewRound = {
  number: 1,
  state: 'draft',
  openedAt: '2026-09-07T14:00:00Z',
  responses: [],
  asset: {
    contentRef: 'content-one',
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/png',
    media: { kind: 'image', width: 100, height: 100 },
    ownerReceiptRef: 'receipt:one',
    sourcePublication: { artifactRef: '/uploads/one.png', sourceRef: 'message:thread-one:one', revision: '1' },
  },
  annotations: [
    {
      id: 'mark',
      author: { kind: 'human', actorId: 'operator' },
      body: '已经保存的意见',
      anchor: { kind: 'image-region', x: 1, y: 1, width: 5, height: 5 },
      state: 'open',
      replies: [],
      createdAt: '2026-09-07T14:00:00Z',
      updatedAt: '2026-09-07T14:00:00Z',
    },
  ],
};
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}
async function type(value: string, label: string) {
  const area = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  expect(area).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, value);
    area?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('cancel and reopen preserves an unfinished annotation edit', async () => {
  await act(async () =>
    root.render(
      createElement(ReviewComments, {
        round,
        ownerUserId: 'operator',
        draftPrefix: 'round:1:',
        activeId: null,
        canWrite: true,
        historical: false,
        saving: false,
        onActive: vi.fn(),
        act: vi.fn(),
      }),
    ),
  );
  await click('修改');
  await type('尚未提交的新措辞', '修改标注 1');
  await click('取消');
  await click('修改');
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="修改标注 1"]')?.value).toBe(
    '尚未提交的新措辞',
  );
});
it('an explicitly emptied reply draft stays empty across closing and reopening its editor', async () => {
  await act(async () =>
    root.render(
      createElement(ReviewReply, {
        reply: {
          id: 'reply',
          author: { kind: 'human', actorId: 'operator' },
          body: '已保存的回复',
          createdAt: '2026-09-07T14:00:00Z',
          updatedAt: '2026-09-07T14:00:00Z',
        },
        ownerUserId: 'operator',
        canEdit: true,
        saving: false,
        draftKey: 'reply-edit',
        onSave: vi.fn(),
      }),
    ),
  );
  await click('修改回复');
  await type('', '修改自己的回复');
  await click('取消修改');
  await click('修改回复');
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
});
it('reanchoring never replaces an existing new-version draft, even if it is from an unknown schema', () => {
  const draft = { body: '旧版意见', anchor: null, reanchoredFrom: { round: 1, annotationId: 'mark' } };
  for (const saved of [JSON.stringify({ body: '新版尚未保存的意见', anchor: null }), '{future-draft}']) {
    localStorage.setItem('round:2', saved);
    expect(startReviewReanchor('round:2', draft)).toBe('existing');
    expect(localStorage.getItem('round:2')).toBe(saved);
  }
  localStorage.removeItem('round:2');
  expect(startReviewReanchor('round:2', draft)).toBe('created');
  expect(JSON.parse(localStorage.getItem('round:2') ?? '{}')).toEqual(draft);
});
it('a browser storage failure leaves the source annotation available for a retry', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  expect(startReviewReanchor('round:2', { body: '旧版意见', anchor: null })).toBe('unavailable');
});

it('moves from a canvas mark into its real discussion and lets Escape return to that mark', async () => {
  const onReturnToCanvas = vi.fn();
  await act(async () =>
    root.render(
      createElement(ReviewComments, {
        round,
        ownerUserId: 'operator',
        draftPrefix: 'round:1:',
        activeId: 'mark',
        canWrite: true,
        historical: false,
        saving: false,
        onActive: vi.fn(),
        onReturnToCanvas,
        focusRequest: { annotationId: 'mark', requestId: 1 },
        act: vi.fn(),
      }),
    ),
  );
  const thread = container.querySelector<HTMLElement>('[data-testid="review-comment"]');
  expect(document.activeElement).toBe(thread);
  await act(async () => thread?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(onReturnToCanvas).toHaveBeenCalledWith('mark');
});
