import type { ContentModificationDetailView, ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ContentModificationPanel } from '../ContentModificationPanel';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));

it('keeps cancellation separate from a running executor, reconciles a lost response, and never repeats the original submission', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mocks.fetch.mockReset();
  const source: ContentModificationRequest['source'] = {
    kind: 'workspace',
    locator: { worktreeId: 'work', path: 'guide.md' },
    expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
    reviewId: 'original',
    expectedReviewRevision: 1,
  };
  let view: ContentModificationDetailView = {
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
        operationId: crypto.randomUUID(),
        source,
        targetCatId: 'codex-astra',
        threadId: 'execution',
        intent: { body: '请修改用词' },
      },
    },
    execution: {
      state: 'running',
      messageId: 'carrier',
      invocationId: 'child',
      targetCatId: 'codex-astra',
      observedAt: 1,
      evidenceRef: 'turn-execution:child',
    },
  };
  let cancelled = 0;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/cancel')) {
      cancelled += 1;
      view = {
        ...view,
        stage: 'cancelled',
        record: {
          ...view.record,
          control: {
            state: 'cancelled',
            actorId: 'operator',
            receiptRef: 'request#cancelled',
            cancelledAt: 2,
            taskResolution: 'preserved',
          },
        },
      };
      throw new Error('lost cancel response');
    }
    return new Response(JSON.stringify(url.endsWith('/choices') ? { cats: [], threads: [] } : view));
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
    const button = element.querySelector<HTMLButtonElement>('[data-testid="content-modification-cancel"]');
    expect(button, 'a submitted request must have an explicit cancellation action').not.toBeNull();
    await act(async () => button?.click());
    expect(cancelled).toBe(1);
    await act(async () => root.render(null));
    await render();
    expect(element.querySelector('output')?.textContent).toContain('本次修改请求已取消');
    expect(element.querySelector('output')?.textContent).toContain('本轮执行仍在继续');
    expect(element.textContent).toContain('原委托保留');
    expect(element.querySelector('[data-testid="content-modification-cancel"]')).toBeNull();
    expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/content-modifications')).toBe(false);
    expect(cancelled, 'reload reads the cancellation instead of repeating an execution stop').toBe(1);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.restoreAllMocks();
  }
});

it('finds the same persisted request and allows cancellation while the first submission is still awaiting Task admission', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mocks.fetch.mockReset();
  const source: ContentModificationRequest['source'] = {
    kind: 'workspace',
    locator: { worktreeId: 'work', path: 'guide.md' },
    expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
    reviewId: 'original',
    expectedReviewRevision: 1,
  };
  let view: ContentModificationDetailView | null = null,
    release!: (response: Response) => void;
  const blocked = new Promise<Response>((resolve) => {
    release = resolve;
  });
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/choices'))
      return new Response(
        JSON.stringify({
          cats: [{ catId: 'codex-astra', name: '小星星', mcpSupport: true, restrictions: [] }],
          threads: [{ threadId: 'execution', title: '原对话' }],
        }),
      );
    if (url === '/api/content-modifications') {
      const payload = JSON.parse(String(init?.body)) as ContentModificationRequest;
      view = {
        stage: 'admitting_task',
        candidates: [],
        acceptances: [],
        record: {
          requestId: 'request',
          ownerUserId: 'operator',
          revision: 1,
          payload,
          progress: {},
          createdAt: 1,
          updatedAt: 1,
        },
      };
      return blocked;
    }
    if (!view) return new Response('{}', { status: 404 });
    if (url.endsWith('/cancel'))
      view = {
        ...view,
        stage: 'cancelled',
        record: {
          ...view.record,
          control: {
            state: 'cancelled',
            receiptRef: 'request#cancelled',
            actorId: 'operator',
            cancelledAt: 2,
            taskResolution: 'unknown',
          },
        },
      };
    return new Response(JSON.stringify(view));
  });
  const element = document.createElement('div'),
    root = createRoot(element);
  document.body.append(element);
  try {
    await act(async () =>
      root.render(
        <ContentModificationPanel
          ownerUserId="operator"
          source={source}
          title="说明书"
          initialBody="请修改用词"
          suggestedCatId="codex-astra"
          suggestedThreadId="execution"
          onClose={() => {}}
        />,
      ),
    );
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[data-testid="content-modification-submit"]')?.click(),
    );
    const cancel = element.querySelector<HTMLButtonElement>('[data-testid="content-modification-cancel"]');
    expect(cancel, 'the pending original HTTP call must not prevent a real cancel action').not.toBeNull();
    expect(cancel?.disabled).toBe(false);
    await act(async () => cancel?.click());
    expect(element.querySelector('output')?.textContent).toContain('本次修改请求已取消');
    expect(mocks.fetch.mock.calls.filter(([url]) => url === '/api/content-modifications')).toHaveLength(1);
    await act(async () => release(new Response(JSON.stringify(view))));
    expect(element.querySelector('output')?.textContent).toContain('本次修改请求已取消');
  } finally {
    release(new Response(JSON.stringify(view)));
    await act(async () => root.unmount());
    element.remove();
    vi.restoreAllMocks();
  }
});
