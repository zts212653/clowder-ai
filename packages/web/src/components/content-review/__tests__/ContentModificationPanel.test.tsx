import type { ContentModificationDetailView, ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationLanding } from '../ContentModificationLanding';
import { ContentModificationPanel } from '../ContentModificationPanel';
import { ContentModificationResults } from '../ContentModificationResults';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
const baseRevision = `sha256:${'a'.repeat(64)}`;
const resultRevision = `sha256:${'b'.repeat(64)}`;
const source: ContentModificationRequest['source'] = {
  kind: 'workspace',
  locator: { worktreeId: 'work', path: 'guide.md' },
  expectedSourceRevision: baseRevision,
  reviewId: 'file-review',
  expectedReviewRevision: 1,
};
const requestId = `f309-modification-${'c'.repeat(64)}`;
const choices = {
  cats: [
    { catId: 'opus5', name: '宪宪', mcpSupport: true, restrictions: [] },
    { catId: 'codex-astra', name: '小星星', mcpSupport: true, restrictions: [] },
  ],
  threads: [{ threadId: 'execution', title: '修改说明书' }],
};
const json = (data: unknown) => new Response(JSON.stringify(data));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mocks.apiFetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function flush() {
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
}
async function click(testId: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(false);
  await act(async () => {
    button?.click();
    await flush();
  });
}
async function chooseCat(catId: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="修改目标猫"]');
    if (!select) throw new Error('missing named cat selection');
    select.value = catId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  });
}

it.each([
  ['running', '正在执行'],
  ['finished', '本轮执行已结束，等待作品结果'],
  ['failed', '本轮执行失败'],
  ['unknown', '执行状态暂不可核验'],
] as const)('shows %s from actual execution facts without claiming result or Task completion', async (state, label) => {
  const view: ContentModificationDetailView = {
    stage: 'queued',
    record: {
      requestId,
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
        intent: { body: '修改用词' },
      },
    },
    candidates: [],
    acceptances: [],
    execution: {
      state,
      messageId: 'carrier',
      invocationId: 'child',
      targetCatId: 'codex-astra',
      observedAt: 1,
      evidenceRef: 'turn-execution:child',
    },
  };
  mocks.apiFetch.mockImplementation(async (url: string) => (url.endsWith('/choices') ? json(choices) : json(view)));
  await act(async () =>
    root.render(
      <ContentModificationPanel
        source={source}
        ownerUserId="operator"
        title="说明书"
        initialRequest={view.record}
        onClose={() => {}}
      />,
    ),
  );
  expect(container.querySelector('output')?.textContent).toContain(label);
  expect(container.textContent).not.toContain('任务已完成');
  expect(container.textContent).not.toContain('新版已返回');
});

it('requires an explicit cat, keeps the original request across an unknown response/reopen, and writes only after an independent accept', async () => {
  let view: ContentModificationDetailView | undefined;
  let lostSubmit = true,
    lostAccept = true;
  const submissions: ContentModificationRequest[] = [];
  const accepts: Record<string, string>[] = [];
  const onApplied = vi.fn();
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/content-modifications/choices') return json(choices);
    if (url === '/api/content-modifications') {
      const payload = JSON.parse(String(init?.body)) as ContentModificationRequest;
      submissions.push(payload);
      view ??= {
        stage: 'queued',
        record: {
          requestId,
          ownerUserId: 'operator',
          payload,
          revision: 5,
          createdAt: 1,
          updatedAt: 5,
          progress: { task: { taskId: 'task-one', revision: 1, receiptRef: 'task-receipt' } },
        },
        candidates: [
          {
            kind: 'text',
            candidateRef: 'proposal-one',
            proposal: {
              proposalRef: 'proposal-one',
              requestId,
              revision: 1,
              operationId: 'result-operation',
              baseRevision,
              resultRevision,
              edits: [{ start: 0, end: 3, expectedText: 'old', replacement: 'new' }],
              response: '已更正用词',
              authorCatId: 'codex-astra',
              createdAt: 10,
              receiptRef: 'proposal-receipt',
            },
          },
        ],
        acceptances: [],
      };
      if (lostSubmit) {
        lostSubmit = false;
        throw new Error('response lost after source commit');
      }
      return json(view);
    }
    if (url === `/api/content-modifications/${requestId}`) return json(view);
    if (url === '/api/workspace/edit-session') return json({ token: 'temporary-edit-token' });
    if (url.endsWith('/accept')) {
      if (!view) throw new Error('no accepted request');
      const payload = JSON.parse(String(init?.body)) as Record<string, string>;
      accepts.push(payload);
      const acceptOperationId = payload.acceptOperationId;
      if (!acceptOperationId) throw new Error('missing accept operation identity');
      view.acceptances = [
        {
          acceptance: {
            requestId,
            ownerUserId: 'operator',
            acceptOperationId,
            candidateRef: 'proposal-one',
            baseRevision,
            locator: source.locator,
            humanReceiptRef: 'human-accept',
            fileReceiptRef: 'file-write',
            acceptedAt: 20,
          },
          receipt: {
            receiptRef: 'file-write',
            ownerUserId: 'operator',
            locator: source.locator,
            baseRevision,
            candidateRevision: resultRevision,
            requestId,
            candidateRef: 'proposal-one',
            acceptOperationId,
            state: 'applied',
            writtenRevision: resultRevision,
            currentRevision: resultRevision,
          },
        },
      ];
      if (lostAccept) {
        lostAccept = false;
        throw new Error('response lost after file write');
      }
      return json(view.acceptances[0]);
    }
    throw new Error(`Unexpected route ${url}`);
  });
  const render = async () =>
    act(async () => {
      root.render(
        <ContentModificationPanel
          title="guide.md"
          ownerUserId="operator"
          source={source}
          initialBody="把old改成new"
          suggestedThreadId="execution"
          onClose={vi.fn()}
          onApplied={onApplied}
        />,
      );
      await flush();
    });
  await render();
  expect(container.querySelector<HTMLSelectElement>('[aria-label="修改目标猫"]')?.value).toBe('');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="content-modification-submit"]')?.disabled).toBe(
    true,
  );
  await chooseCat('codex-astra');
  await click('content-modification-submit');
  expect(submissions).toHaveLength(1);
  expect(submissions[0]?.targetCatId).toBe('codex-astra');
  await act(async () => {
    root.render(null);
    await flush();
  });
  await render();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="修改说明"]')?.value).toBe('把old改成new');
  await click('content-modification-submit');
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(container.textContent).toContain('新版结果已返回');
  expect(container.textContent).toContain('新版已返回');
  expect(container.querySelector('del')?.textContent).toBe('old');
  expect(container.querySelector('ins')?.textContent).toBe('new');
  expect(mocks.apiFetch.mock.calls.some(([url]) => url === '/api/workspace/edit-session')).toBe(false);
  await click('content-modification-accept');
  expect(accepts).toHaveLength(1);
  expect(accepts[0]?.editSessionToken).toBe('temporary-edit-token');
  expect(accepts[0]?.baseRevision).toBe(baseRevision);
  await click('content-modification-accept');
  expect(accepts, 'known applied retry reads the owner receipt without writing twice').toHaveLength(1);
  expect(onApplied).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('已写回原文件');
  expect(Object.values(localStorage).join('')).not.toContain('temporary-edit-token');
});

it('keeps a blocked named target and never silently chooses another cat', async () => {
  // This entry starts without a request; blocking availability must retain the selected named cat.
  mocks.apiFetch.mockResolvedValue(
    json({
      ...choices,
      cats: choices.cats.map((cat) => ({
        ...cat,
        preflight: { targetCatId: cat.catId, disposition: 'rejected', reasons: [] },
      })),
    }),
  );
  await act(async () => {
    root.render(
      <ContentModificationPanel
        title="guide.md"
        source={source}
        ownerUserId="operator"
        suggestedCatId="codex-astra"
        suggestedThreadId="execution"
        initialBody="修改文字"
        onClose={vi.fn()}
      />,
    );
    await flush();
  });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="修改目标猫"]')?.value).toBe('codex-astra');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="content-modification-submit"]')?.disabled).toBe(
    true,
  );
  expect(container.textContent).toContain('尚未改派');
  expect(mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/content-modifications')).toHaveLength(0);
});

it('separates a completed writeback from a later change to the file', async () => {
  const view: ContentModificationDetailView = {
    stage: 'queued',
    record: {
      requestId,
      ownerUserId: 'operator',
      payload: {
        operationId: crypto.randomUUID(),
        targetCatId: 'codex-astra',
        threadId: 'execution',
        source,
        intent: { body: '更新文字' },
      },
      progress: {},
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    candidates: [
      {
        kind: 'text',
        candidateRef: 'candidate',
        proposal: {
          proposalRef: 'candidate',
          requestId,
          revision: 1,
          operationId: 'return-op',
          baseRevision,
          resultRevision,
          edits: [{ start: 0, end: 3, expectedText: 'old', replacement: 'new' }],
          response: '已更新',
          authorCatId: 'codex-astra',
          createdAt: 2,
          receiptRef: 'returned',
        },
      },
    ],
    acceptances: [
      {
        acceptance: {
          requestId,
          ownerUserId: 'operator',
          acceptOperationId: 'accept-op',
          candidateRef: 'candidate',
          baseRevision,
          locator: source.locator,
          humanReceiptRef: 'human-accept',
          fileReceiptRef: 'writeback',
          acceptedAt: 3,
        },
        receipt: {
          receiptRef: 'writeback',
          ownerUserId: 'operator',
          locator: source.locator,
          baseRevision,
          candidateRevision: resultRevision,
          requestId,
          candidateRef: 'candidate',
          acceptOperationId: 'accept-op',
          state: 'applied',
          writtenRevision: resultRevision,
          currentRevision: `sha256:${'d'.repeat(64)}`,
        },
      },
    ],
  };
  await act(async () => root.render(<ContentModificationResults view={view} busy={false} onAccept={vi.fn()} />));
  expect(container.querySelector('output')?.textContent).toBe('本次已写回；文件随后又有改动。');
  expect(container.querySelector('[data-testid="content-modification-accept"]')).toBeNull();
});

it('recovers a sole real request without localStorage, and continues with that Task and named owner', async () => {
  const record = {
    requestId,
    ownerUserId: 'operator',
    revision: 5,
    createdAt: 1,
    updatedAt: 5,
    payload: {
      operationId: crypto.randomUUID(),
      source,
      targetCatId: 'codex-astra',
      threadId: 'execution',
      intent: { body: '原来的修改说明' },
    },
    progress: { task: { taskId: 'actual-task', revision: 2, receiptRef: 'admitted' } },
  };
  const taskContext = { kind: 'text' as const, taskId: 'actual-task', expectedTaskRevision: 2 };
  const catalogue = {
    requests: [{ stage: 'queued', record }],
    contexts: [
      {
        taskId: 'actual-task',
        title: '修改说明书',
        targetCatId: 'codex-astra',
        targetName: '小星星',
        threadId: 'execution',
        threadTitle: '修改说明书',
        requestIds: [requestId],
        state: 'active',
        taskContext,
      },
    ],
  };
  const submitted: ContentModificationRequest[] = [];
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/context')) return json(catalogue);
    if (url.endsWith('/choices')) return json(choices);
    if (url === '/api/content-modifications') {
      submitted.push(JSON.parse(String(init?.body)));
      return json({ stage: 'queued', record });
    }
    if (url.endsWith(requestId)) return json({ stage: 'queued', record, candidates: [], acceptances: [] });
    throw new Error(`Unexpected ${url}`);
  });
  await act(async () => {
    root.render(
      <ContentModificationLanding
        title="guide.md"
        source={source}
        ownerUserId="operator"
        initialBody="继续更正措辞"
        onClose={vi.fn()}
      />,
    );
    await flush();
  });
  expect(container.textContent).toContain('原来的修改说明');
  expect(container.querySelector('[aria-label="作品修改上下文"]')).toBeNull();
  expect(submitted).toHaveLength(0);
  await click('content-modification-continue');
  const owner = container.querySelector<HTMLSelectElement>('[aria-label="修改目标猫"]');
  expect(owner?.value).toBe('codex-astra');
  expect(owner?.disabled).toBe(true);
  await click('content-modification-submit');
  expect(submitted[0]?.taskContext).toEqual(taskContext);
  expect(submitted[0]?.targetCatId).toBe('codex-astra');
});

it('does not choose the first of two real modification contexts', async () => {
  const records = ['one', 'two'].map((id, index) => ({
    requestId: id,
    ownerUserId: 'operator',
    revision: 1,
    createdAt: index + 1,
    updatedAt: 2,
    payload: {
      operationId: crypto.randomUUID(),
      source,
      targetCatId: index ? 'opus5' : 'codex-astra',
      threadId: 'execution',
      intent: { body: id },
    },
    progress: {},
  }));
  mocks.apiFetch.mockResolvedValue(
    json({
      requests: records.map((record) => ({ stage: 'queued', record })),
      contexts: records.map((record) => ({
        taskId: record.requestId,
        title: '原任务',
        targetCatId: record.payload.targetCatId,
        targetName: record.payload.targetCatId === 'opus5' ? '宪宪' : '小星星',
        threadId: 'execution',
        threadTitle: '修改说明书',
        requestIds: [record.requestId],
        state: 'active',
      })),
    }),
  );
  await act(async () => {
    root.render(
      <ContentModificationLanding title="guide.md" source={source} ownerUserId="operator" onClose={vi.fn()} />,
    );
    await flush();
  });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="作品修改上下文"]')?.value).toBe('');
  expect(container.querySelector('[data-testid="content-modification-submit"]')).toBeNull();
  expect(container.textContent).toContain('宪宪');
  expect(container.textContent).toContain('小星星');
});
