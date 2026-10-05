import type {
  ContentModificationDetailView,
  ContentModificationRequest,
  WorkspaceContentReview,
} from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ContentModificationPanel } from '../ContentModificationPanel';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('../ReviewActor', () => ({
  ReviewActor: ({ actor }: { actor: { actorId: string } }) => <span>{actor.actorId}</span>,
}));

it('shows frozen original comments, replies and mark provenance without offering a second writable discussion', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const revision = `sha256:${'a'.repeat(64)}`,
    date = '2026-09-20T00:00:00.000Z';
  const locator = { worktreeId: 'work', path: 'original.png' };
  const review: WorkspaceContentReview = {
    version: 1,
    reviewId: 'original-review',
    ownerUserId: 'operator',
    contentRef: 'original-content',
    revision: 3,
    createdAt: date,
    updatedAt: date,
    source: {
      kind: 'media',
      locator,
      revision,
      mime: 'image/png',
      byteLength: 100,
      media: { kind: 'image', width: 160, height: 100 },
    },
    annotations: [
      {
        id: 'original-annotation',
        anchor: { baseRevision: revision, anchor: { kind: 'image-point', x: 10, y: 20 } },
        body: '这里要保留人物',
        author: { kind: 'human', actorId: 'operator' },
        state: 'open',
        createdAt: date,
        updatedAt: date,
        replies: [
          {
            id: 'original-reply',
            body: '已记下这条原意见',
            author: { kind: 'cat', actorId: 'opus5' },
            createdAt: date,
            updatedAt: date,
          },
        ],
      },
    ],
    visualMarks: [
      {
        drawing: {
          kind: 'text',
          id: 'mark',
          color: '#d04a3a',
          strokeWidth: 2,
          at: { x: 10, y: 20 },
          text: '原位置提示',
          fontSize: 14,
        },
        baseRevision: revision,
        author: { kind: 'cat', actorId: 'codex-astra' },
        createdAt: date,
        state: 'active',
      },
    ],
  };
  const source: ContentModificationRequest['source'] = {
    kind: 'workspace',
    locator,
    expectedSourceRevision: revision,
    reviewId: review.reviewId,
    expectedReviewRevision: 3,
  };
  const view: ContentModificationDetailView = {
    stage: 'queued',
    candidates: [],
    acceptances: [],
    record: {
      requestId: 'request',
      ownerUserId: 'operator',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      progress: {},
      payload: {
        operationId: 'op',
        source,
        targetCatId: 'codex-astra',
        threadId: 'execution',
        intent: { body: '请调整背景' },
      },
    },
    sourceDiscussions: [{ requestId: 'request', title: 'original.png', readOnly: true, review }],
  };
  mocks.fetch.mockImplementation(
    async (url: string) => new Response(JSON.stringify(url.endsWith('/choices') ? { cats: [], threads: [] } : view)),
  );
  const element = document.createElement('div'),
    root = createRoot(element);
  document.body.append(element);
  try {
    await act(async () => {
      root.render(
        <ContentModificationPanel
          ownerUserId="operator"
          source={source}
          title="派生作品"
          initialRequest={view.record}
          onClose={() => {}}
        />,
      );
    });
    const section = element.querySelector('[data-testid="content-source-discussions"]');
    expect(section?.textContent).toContain('这里要保留人物');
    expect(section?.textContent).toContain('已记下这条原意见');
    expect(section?.textContent).toContain('opus5');
    expect(section?.textContent).toContain('原位置提示');
    expect(section?.textContent).toContain('codex-astra');
    expect(section?.textContent).toContain('提交时的原件讨论');
    expect(section?.querySelector('textarea,input,canvas')).toBeNull();
    expect(section?.querySelector('[data-testid="content-source-discussion-provenance"]')?.textContent).toContain(
      'original-review',
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.restoreAllMocks();
  }
});
