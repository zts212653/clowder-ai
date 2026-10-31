import type { ContentModificationDetailView, ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ContentModificationPanel } from '../ContentModificationPanel';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));

it('retains an unknown rejection on reload, blocks acceptance until resolved and preserves the declined candidate', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mocks.fetch.mockReset();
  const source: ContentModificationRequest['source'] = {
    kind: 'workspace',
    locator: { worktreeId: 'work', path: 'guide.md' },
    reviewId: 'review',
    expectedReviewRevision: 1,
    expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
  };
  const view: ContentModificationDetailView = {
    stage: 'queued',
    rejections: [],
    acceptances: [],
    record: {
      requestId: 'request',
      ownerUserId: 'operator',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      progress: {},
      payload: {
        operationId: crypto.randomUUID(),
        source,
        targetCatId: 'codex-astra',
        threadId: 'execution',
        intent: { body: '修改用词' },
      },
    },
    candidates: [
      {
        kind: 'text',
        candidateRef: 'candidate',
        proposal: {
          requestId: 'request',
          proposalRef: 'candidate',
          revision: 1,
          operationId: 'response',
          authorCatId: 'codex-astra',
          baseRevision: source.expectedSourceRevision,
          resultRevision: `sha256:${'b'.repeat(64)}`,
          createdAt: 2,
          receiptRef: 'response-receipt',
          response: '候选已返回',
          edits: [{ start: 0, end: 3, expectedText: 'old', replacement: 'new' }],
        },
      },
    ],
  };
  let attempts = 0;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/choices')) return new Response(JSON.stringify({ cats: [], threads: [] }));
    if (url.endsWith('/reject')) {
      if (++attempts === 1) throw new Error('response unknown');
      const rejection = {
        requestId: 'request',
        candidateRef: 'candidate',
        ownerUserId: 'operator',
        actorId: 'operator',
        state: 'rejected' as const,
        rejectedAt: 3,
        receiptRef: 'human-rejection',
      };
      view.rejections = [rejection];
      return new Response(JSON.stringify(rejection));
    }
    return new Response(JSON.stringify(view));
  });
  const element = document.createElement('div'),
    root = createRoot(element);
  document.body.append(element);
  const render = () =>
    act(async () =>
      root.render(
        <ContentModificationPanel
          ownerUserId="operator"
          source={source}
          title="说明书"
          initialRequest={view.record}
          onClose={() => {}}
        />,
      ),
    );
  try {
    await render();
    const button = element.querySelector<HTMLButtonElement>('[data-testid="content-modification-reject"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(element.textContent).toContain('拒绝结果尚未确认');
    await act(async () => root.render(null));
    await render();
    expect(attempts).toBe(1);
    expect(element.querySelector<HTMLButtonElement>('[data-testid="content-modification-accept"]')?.disabled).toBe(
      true,
    );
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[data-testid="content-modification-reject"]')?.click(),
    );
    expect(attempts).toBe(2);
    expect(element.textContent).toContain('已拒绝此候选');
    expect(element.querySelector('[data-testid="content-modification-result"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="content-modification-accept"]')).toBeNull();
    expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/content-modifications')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
