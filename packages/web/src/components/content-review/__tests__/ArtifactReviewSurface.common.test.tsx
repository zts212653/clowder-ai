import type { ArtifactReviewView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mediaView } from '@/components/workbench/content-review/__tests__/WorkspaceContentReviewSurface.fixture';
import { workspaceReviewDraftKey } from '@/components/workbench/content-review/workspace-review-draft';
import { contentContextSelectionKey } from '@/components/workbench/PublicationLandingResolver';
import { ArtifactReviewSurface } from '../ArtifactReviewSurface';

const mocks = vi.hoisted(() => ({ controller: vi.fn(), act: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../useArtifactReview', () => ({
  useArtifactReview: (reviewId: string) => mocks.controller(reviewId),
  reviewDraftPrefix: (user: string, id: string) => `cat-cafe:review:${user}:${id}:`,
}));
vi.mock('../useReviewMediaSource', () => ({
  useReviewMediaSource: () => ({ src: 'blob:original-owner-media', error: null }),
}));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../ReviewActor', () => ({ ReviewActor: () => <span>原作者</span> }));
const stamp = '2026-09-20T04:00:00Z';
const view: ArtifactReviewView = {
  review: {
    version: 2,
    reviewId: `review-${'a'.repeat(64)}`,
    revision: 2,
    title: '旧版/完整作品名',
    contentRef: `prepared-media:${'b'.repeat(64)}`,
    task: { taskId: 'task-one', threadId: 'thread-one', ownerUserId: 'operator', observedRevision: 1 },
    createdAt: stamp,
    updatedAt: stamp,
    rounds: [
      {
        number: 1,
        openedAt: stamp,
        state: 'draft',
        responses: [],
        asset: {
          contentRef: `prepared-media:${'b'.repeat(64)}`,
          ownerRevision: 1,
          blobDigest: `sha256:${'c'.repeat(64)}`,
          mediaType: 'image/png',
          media: { kind: 'image', width: 100, height: 100 },
          ownerReceiptRef: 'owner:one',
          sourcePublication: { artifactRef: '/uploads/old.png', sourceRef: 'message:thread-one:old', revision: '1' },
        },
        annotations: [
          {
            id: 'original',
            body: '保留原批注',
            anchor: { kind: 'image-point', x: 4, y: 5 },
            author: { kind: 'cat', actorId: 'codex-astra' },
            state: 'open',
            createdAt: stamp,
            updatedAt: stamp,
            replies: [],
          },
        ],
      },
    ],
  },
  authority: { state: 'current', canWrite: true, taskRevision: 1, ownerCatId: 'codex-astra' },
  pendingVersion: false,
  continuation: {
    taskId: 'task-one',
    expectedRevision: 1,
    artifactRef: 'content:old',
    reviewEvidenceRef: 'review:original',
    ownerCatId: 'codex-astra',
  },
};
let root: Root, container: HTMLDivElement;
const draftKey = `cat-cafe:review:operator:${view.review.reviewId}:round:1:annotation`;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mocks.apiFetch.mockReset();
  mocks.act.mockReset().mockResolvedValue(false);
  mocks.controller.mockReturnValue({
    view,
    error: null,
    pending: null,
    saving: false,
    loading: false,
    act: mocks.act,
    retry: vi.fn(),
    refresh: vi.fn(),
    revokeAccess: vi.fn(),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it('renders the common landing using original media, actor, annotation IDs and durable draft prefix', async () => {
  localStorage.setItem(draftKey, JSON.stringify({ body: '原草稿', anchor: { kind: 'image-point', x: 8, y: 9 } }));
  await act(async () => root.render(<ArtifactReviewSurface reviewId={view.review.reviewId} onBack={vi.fn()} />));
  expect(container.querySelector('[data-testid="workspace-content-review-surface"]')).not.toBeNull();
  expect(container.querySelector('h2')?.textContent).toBe('旧版/完整作品名');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:original-owner-media');
  expect(container.querySelector('[data-annotation-id="original"]')).not.toBeNull();
  expect(container.querySelector('textarea')?.value).toBe('原草稿');
  const save = container.querySelector<HTMLButtonElement>('[aria-label="保存批注"]');
  await act(async () => save?.click());
  expect(mocks.act).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'annotate', body: '原草稿', anchor: { kind: 'image-point', x: 8, y: 9 } }),
    1,
  );
  expect(JSON.parse(localStorage.getItem(draftKey)!)).toEqual({
    body: '原草稿',
    anchor: { kind: 'image-point', x: 8, y: 9 },
  });
  expect(container.querySelector('[data-testid="content-modification-entry"]')).not.toBeNull();
});
it('opening discussion and switching canvas modes never discards the original unsaved selection', async () => {
  const original = { body: '保留选区', anchor: { kind: 'image-point', x: 8, y: 9 } };
  localStorage.setItem(draftKey, JSON.stringify(original));
  await act(async () => root.render(<ArtifactReviewSurface reviewId={view.review.reviewId} onBack={vi.fn()} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开作品讨论"]')?.click());
  expect(container.textContent).toContain('保留原批注');
  expect(JSON.parse(localStorage.getItem(draftKey)!)).toEqual(original);
});
it('does not silently substitute the latest round for a missing explicitly restored version', async () => {
  await act(async () =>
    root.render(<ArtifactReviewSurface reviewId={view.review.reviewId} initialRound={9} onBack={vi.fn()} />),
  );
  expect(container.textContent).toContain('第 9 版暂不可读取');
  expect(container.querySelector('img')).toBeNull();
  const choose = [...container.querySelectorAll('button')].find((button) => button.textContent === '查看当前第 1 版');
  await act(async () => choose?.click());
  expect(container.querySelector('img')).not.toBeNull();
});

it('switches a named context from the open work and restores each original draft without submitting it', async () => {
  const other = structuredClone(view);
  other.review.reviewId = `review-${'d'.repeat(64)}`;
  other.review.task = { ...view.review.task, taskId: 'task-two', threadId: 'thread-two' };
  const choices = [view, other].map((item, index) => ({
    reviewId: item.review.reviewId,
    round: 1,
    taskId: item.review.task.taskId,
    threadId: item.review.task.threadId,
    title: item.review.title,
    taskTitle: `修改方案${index + 1}`,
    threadTitle: `原对话${index + 1}`,
    targetCatId: 'codex-astra',
    targetName: '小星星',
    state: 'draft',
    taskState: 'active',
  }));
  const base = mocks.controller();
  mocks.controller.mockImplementation((id: string) => ({ ...base, view: id === other.review.reviewId ? other : view }));
  mocks.apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: choices })),
  );
  const drafts = [draftKey, `cat-cafe:review:operator:${other.review.reviewId}:round:1:annotation`];
  drafts.forEach((key, index) =>
    localStorage.setItem(
      key,
      JSON.stringify({ body: `未提交方案${index + 1}`, anchor: { kind: 'image-point', x: 8, y: 9 } }),
    ),
  );
  const change = vi.fn();
  const render = async (id: string) =>
    act(async () => {
      root.render(<ArtifactReviewSurface reviewId={id} onBack={vi.fn()} onContextChange={change} />);
      for (let n = 0; n < 8; n++) await Promise.resolve();
    });
  await render(view.review.reviewId);
  const select = container.querySelector<HTMLSelectElement>('[aria-label="作品讨论上下文"]');
  expect(select, 'the already-open landing must retain its context selector').not.toBeNull();
  expect(select?.value).toBe(view.review.reviewId);
  expect(select?.textContent).toContain('原对话2');
  expect(change).not.toHaveBeenCalled();
  select!.value = other.review.reviewId;
  await act(async () => select!.dispatchEvent(new Event('change', { bubbles: true })));
  expect(change).toHaveBeenCalledWith(choices[1]);
  expect(localStorage.getItem(contentContextSelectionKey('operator', view.review.contentRef))).toBe(
    other.review.reviewId,
  );
  await render(other.review.reviewId);
  expect(container.querySelector('textarea')?.value).toBe('未提交方案2');
  await render(view.review.reviewId);
  expect(container.querySelector('textarea')?.value).toBe('未提交方案1');
  expect(mocks.act).not.toHaveBeenCalled();
  expect(mocks.apiFetch.mock.calls.every(([url]) => url === '/api/content-reviews/resolve')).toBe(true);
});

it('a linked Task context resumes the publication draft and its exact unknown operation instead of a second Task draft', async () => {
  const task = structuredClone(view);
  task.review.version = 3;
  const round = task.review.rounds[0];
  if (!round) throw Error('missing round');
  round.ledgerRef = `workspace-review-${'e'.repeat(64)}`;
  round.ledgerRevision = 1;
  const ledger = mediaView(),
    { media, mediaType, ...publication } = round.asset;
  ledger.review.reviewId = round.ledgerRef;
  ledger.review.source = { kind: 'publication', revision: round.asset.blobDigest, mime: mediaType, media, publication };
  ledger.review.sourceHistory = [ledger.review.source];
  Object.assign(ledger, { currentSource: ledger.review.source });
  localStorage.setItem(
    workspaceReviewDraftKey(ledger),
    JSON.stringify({
      v: 1,
      body: '消息入口没写完的评论',
      target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 8, y: 9 } },
      activeAnnotationId: null,
      annotation: null,
      action: null,
      refresh: null,
    }),
  );
  mocks.controller.mockReturnValue({ ...mocks.controller(), view: task });
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/annotations')) throw Error('unknown response');
    if (url.includes('/operations/')) return new Response(JSON.stringify({ receipt: null }));
    return new Response(JSON.stringify(ledger));
  });
  await act(async () => {
    root.render(<ArtifactReviewSurface reviewId={task.review.reviewId} onBack={vi.fn()} />);
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(container.querySelector('textarea')?.value).toBe('消息入口没写完的评论');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="保存批注"]')?.click());
  const first = mocks.apiFetch.mock.calls.find(([url]) => String(url).endsWith('/annotations'));
  expect(first).toBeTruthy();
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(<ArtifactReviewSurface reviewId={task.review.reviewId} onBack={vi.fn()} />);
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === '核对并重试保存');
  expect(retry?.disabled).toBe(false);
  await act(async () => retry?.click());
  const writes = mocks.apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/annotations'));
  expect(writes).toHaveLength(2);
  expect(JSON.parse(String(writes[1]?.[1]?.body))).toEqual(JSON.parse(String(first?.[1]?.body)));
  expect(mocks.act).not.toHaveBeenCalled();
});
