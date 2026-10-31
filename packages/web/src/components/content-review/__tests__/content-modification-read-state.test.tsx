import type { ContentModificationRecord, ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationPanel } from '../ContentModificationPanel';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.fetch(...args) }));
const source: ContentModificationRequest['source'] = {
  kind: 'workspace',
  locator: { worktreeId: 'work', path: 'guide.md' },
  expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
  reviewId: 'file-review',
  expectedReviewRevision: 1,
};
const record: ContentModificationRecord = {
  requestId: `f309-modification-${'c'.repeat(64)}`,
  ownerUserId: 'operator',
  revision: 3,
  createdAt: 1,
  updatedAt: 3,
  progress: {},
  payload: {
    operationId: '01e1e7ae-1aab-4c68-8a8a-f65765250a9d',
    source,
    targetCatId: 'codex-astra',
    threadId: 'execution',
    intent: { body: '原请求说明' },
  },
  issue: { code: 'delivery_failed', retryable: true },
};
const json = (value: unknown) => new Response(JSON.stringify(value));
const cancelled = () =>
  json({
    stage: 'cancelled',
    record: {
      ...record,
      control: {
        disposition: 'cancelled',
        actorId: 'operator',
        receiptRef: 'cancelled',
        taskResolution: 'preserved',
        createdAt: 4,
      },
    },
    candidates: [],
    acceptances: [],
  });
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mock.fetch.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = () =>
  act(async () =>
    root.render(
      <ContentModificationPanel
        source={source}
        ownerUserId="operator"
        title="说明书"
        initialRequest={record}
        onClose={() => {}}
      />,
    ),
  );
it('a known request reads its actual state before offering a resend or cancellation', async () => {
  let finish!: (response: Response) => void;
  mock.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/choices')
      ? json({ cats: [], threads: [] })
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  await render();
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('[data-testid="content-modification-cancel"]')).toBeNull();
  await act(async () => finish(cancelled()));
  expect(container.textContent).toContain('本次修改请求已取消');
  expect(container.querySelector('form'), 'a retained issue does not make a cancelled request resumable').toBeNull();
  expect(mock.fetch.mock.calls.every(([url]) => url !== '/api/content-modifications')).toBe(true);
});
it('a failed request read can be retried in place without resubmitting or retaining a stale read error', async () => {
  mock.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/choices')
      ? json({ cats: [], threads: [] })
      : new Response(JSON.stringify({ error: { code: 'temporary', message: '读取暂时失败' } }), { status: 503 }),
  );
  await render();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('form')).toBeNull();
  mock.fetch.mockImplementation(async () => cancelled());
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === '重新读取请求')!.click(),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('本次修改请求已取消');
  expect(mock.fetch.mock.calls.every(([, init]) => !init)).toBe(true);
});
