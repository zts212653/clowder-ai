import type {
  ContentModificationContextCatalogue,
  ContentModificationRecord,
  ContentModificationRequest,
  ContentModificationRequestView,
} from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationLanding } from '../ContentModificationLanding';
import { modificationContextSelectionKey } from '../modification-context-selection';
import { modificationSourceVersion } from '../modification-draft';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  onRequestKnown: undefined as ((request: ContentModificationRequestView) => void) | undefined,
}));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../ContentModificationPanel', () => ({
  ContentModificationPanel: (props: {
    initialRequest?: ContentModificationRecord;
    contextKey?: string;
    taskContext?: ContentModificationRequest['taskContext'];
    onRequestKnown?: (request: ContentModificationRequestView) => void;
  }) => {
    mocks.onRequestKnown = props.onRequestKnown;
    return (
      <div
        data-testid="modification-form"
        data-request={props.initialRequest?.requestId}
        data-context={props.contextKey}
        data-task={props.taskContext?.taskId}
      >
        {props.initialRequest ? '原请求' : '新请求'}
      </div>
    );
  },
}));
const source: ContentModificationRequest['source'] = {
  kind: 'publication',
  contentRef: `prepared-media:${'a'.repeat(64)}`,
  ownerRevision: 1,
  ledgerRef: 'ledger',
  expectedLedgerRevision: 1,
};
function catalogue(): ContentModificationContextCatalogue {
  const requests = ['one', 'two'].map((key, index) => ({
    stage: 'queued' as const,
    record: {
      requestId: key,
      ownerUserId: 'operator',
      revision: 1,
      createdAt: index,
      updatedAt: index,
      progress: {},
      payload: {
        operationId: crypto.randomUUID(),
        source,
        targetCatId: 'codex-astra',
        threadId: key,
        intent: { body: key },
      },
    },
  }));
  return {
    requests,
    contexts: requests.map(({ record }) => ({
      taskId: `task-${record.requestId}`,
      title: record.requestId,
      targetCatId: 'codex-astra',
      threadId: record.requestId,
      targetName: '小星星',
      threadTitle: record.requestId,
      requestIds: [record.requestId],
      state: 'active' as const,
      taskContext: {
        kind: 'media',
        taskId: `task-${record.requestId}`,
        expectedTaskRevision: 1,
        reviewId: `review-${record.requestId}`,
        expectedReviewRevision: 1,
        round: 1,
      },
    })),
  };
}
let element: HTMLDivElement, root: ReturnType<typeof createRoot>, current: ContentModificationContextCatalogue;
const render = (taskContext?: ContentModificationRequest['taskContext']) =>
  act(async () =>
    root.render(
      <ContentModificationLanding
        source={source}
        ownerUserId="operator"
        title="封面"
        onClose={() => {}}
        taskContext={taskContext}
      />,
    ),
  );
const choose = (value: string) =>
  act(async () => {
    const select = element.querySelector('select')!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  current = catalogue();
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify(current)));
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(() => {
  act(() => root.unmount());
  element.remove();
});

it('retains the selected request and continuation form across closing and reopening', async () => {
  await render();
  await choose('two');
  expect(element.querySelector('[data-testid="modification-form"]')?.getAttribute('data-request')).toBe('two');
  await act(async () =>
    element.querySelector<HTMLButtonElement>('[data-testid="content-modification-continue"]')!.click(),
  );
  expect(element.querySelector('[data-testid="modification-form"]')?.textContent).toBe('新请求');
  await act(async () => root.render(null));
  await render();
  expect(element.querySelector('[data-testid="modification-form"]')?.textContent).toBe('新请求');
  expect(element.querySelector('[data-testid="modification-form"]')?.getAttribute('data-task')).toBe('task-two');
});

it('retains a pre-upgrade continuation draft coordinate without silently relocating it', async () => {
  localStorage.setItem(
    modificationContextSelectionKey('operator', source),
    JSON.stringify({ v: 1, requestId: 'two', composing: true }),
  );
  await render();
  expect(element.querySelector('[data-testid="modification-form"]')!.getAttribute('data-context')).toBe(
    `task:task-two:${modificationSourceVersion(source)}`,
  );
});

it('cancellation updates continuation in place, and the next same-version request has its own draft key', async () => {
  await render();
  await choose('two');
  await act(async () =>
    element.querySelector<HTMLButtonElement>('[data-testid="content-modification-continue"]')!.click(),
  );
  const firstKey = element.querySelector('[data-testid="modification-form"]')!.getAttribute('data-context');
  const context = current.contexts[1]!,
    taskContext = context.taskContext;
  const next: ContentModificationRequestView = {
    stage: 'queued',
    record: {
      ...current.requests[1]!.record,
      requestId: 'three',
      progress: { task: { taskId: context.taskId, revision: 1, receiptRef: 'admission-two' } },
    },
  };
  current.requests.push(next);
  context.requestIds.push('three');
  delete context.taskContext;
  await act(async () => mocks.onRequestKnown!(next));
  expect(element.querySelector('[data-testid="content-modification-continue"]')).toBeNull();
  next.record = {
    ...next.record,
    revision: 2,
    control: {
      state: 'cancelled',
      actorId: 'operator',
      cancelledAt: 2,
      receiptRef: 'cancelled-three',
      taskResolution: 'preserved',
    },
  };
  context.taskContext = taskContext;
  await act(async () => mocks.onRequestKnown!(next));
  const again = element.querySelector<HTMLButtonElement>('[data-testid="content-modification-continue"]');
  expect(again).not.toBeNull();
  await act(async () => again!.click());
  const secondKey = element.querySelector('[data-testid="modification-form"]')!.getAttribute('data-context');
  expect(secondKey).not.toBe(firstKey);
  await act(async () => root.render(null));
  await render();
  expect(element.querySelector('[data-testid="modification-form"]')!.getAttribute('data-context')).toBe(secondKey);
});

it('does not switch a missing saved request to the remaining request', async () => {
  await render();
  await choose('two');
  await act(async () => root.render(null));
  current.requests = current.requests.slice(0, 1);
  current.contexts = current.contexts.slice(0, 1);
  await render();
  expect(element.querySelector('[data-testid="modification-form"]')).toBeNull();
  expect(element.querySelector('select')?.value).toBe('');
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('上次选择');
});
it('a composing Task draft keeps its storage identity when the work advances to another version', async () => {
  await render();
  await choose('two');
  await act(async () =>
    element.querySelector<HTMLButtonElement>('[data-testid="content-modification-continue"]')!.click(),
  );
  const key = element.querySelector('[data-testid="modification-form"]')!.getAttribute('data-context');
  const newer = { ...source, ownerRevision: 2, ledgerRef: 'new-ledger' };
  const taskContext = current.contexts[1]!.taskContext;
  if (!taskContext || taskContext.kind === 'text') throw Error('expected media context');
  current.contexts[1]!.taskContext = { ...taskContext, round: 2 };
  const openNewer = () =>
    act(async () =>
      root.render(<ContentModificationLanding source={newer} ownerUserId="operator" title="封面" onClose={() => {}} />),
    );
  await openNewer();
  expect(element.querySelector('[data-testid="modification-form"]')!.getAttribute('data-context')).toBe(key);
  await act(async () => root.render(null));
  await openNewer();
  expect(element.querySelector('[data-testid="modification-form"]')!.getAttribute('data-context')).toBe(key);
});

it('an explicit Task context selects that Task without asking again or opening the first unrelated Task', async () => {
  await render(current.contexts[1]!.taskContext);
  expect(element.querySelector('[data-testid="modification-form"]')?.getAttribute('data-request')).toBe('two');
  expect(element.querySelector('[data-testid="modification-form"]')?.getAttribute('data-task')).toBe('task-two');
});

it('a context that closes while its draft is parked does not turn the continuation into a new Task form', async () => {
  await render();
  await choose('two');
  await act(async () =>
    element.querySelector<HTMLButtonElement>('[data-testid="content-modification-continue"]')!.click(),
  );
  await act(async () => root.render(null));
  current.contexts[1]!.state = 'closed';
  delete current.contexts[1]!.taskContext;
  await render();
  expect(element.querySelector('[data-testid="modification-form"]')?.textContent).toBe('原请求');
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('草稿仍已保留');
});

it('a cancelled closed Task leaves an explicit new request on the still-writable original file', async () => {
  const fileSource: ContentModificationRequest['source'] = {
    kind: 'workspace',
    locator: { worktreeId: 'work', path: 'guide.md' },
    expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
    reviewId: 'file-review',
    expectedReviewRevision: 1,
  };
  current.requests = current.requests.slice(0, 1);
  current.contexts = current.contexts.slice(0, 1);
  current.requests[0]!.record.payload.source = fileSource;
  current.requests[0]!.record.control = {
    state: 'cancelled',
    actorId: 'operator',
    cancelledAt: 1,
    receiptRef: 'cancelled-one',
    taskResolution: 'closed',
  };
  current.contexts[0]!.state = 'closed';
  delete current.contexts[0]!.taskContext;
  const open = () =>
    act(async () =>
      root.render(
        <ContentModificationLanding source={fileSource} ownerUserId="operator" title="guide.md" onClose={() => {}} />,
      ),
    );
  await open();
  expect(element.querySelector('[data-testid="modification-form"]')?.getAttribute('data-request')).toBe('one');
  const button = element.querySelector<HTMLButtonElement>('[data-testid="content-modification-new-request"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  const form = element.querySelector('[data-testid="modification-form"]')!;
  expect(form.textContent).toBe('新请求');
  expect(form.getAttribute('data-task')).toBeNull();
  expect(form.getAttribute('data-context')).toBe('new:one');
  await act(async () => root.render(null));
  await open();
  expect(element.querySelector('[data-testid="modification-form"]')?.getAttribute('data-context')).toBe('new:one');
  expect(mocks.apiFetch.mock.calls.every(([url]) => url === '/api/content-modifications/context')).toBe(true);
  const next: ContentModificationRequestView = {
    stage: 'preparing_content',
    record: { ...current.requests[0]!.record, requestId: 'new', control: undefined },
  };
  await act(async () => mocks.onRequestKnown!(next));
  expect(element.querySelector('[data-testid="modification-form"]')?.getAttribute('data-context')).toBe('new:one');
  next.stage = 'queued';
  next.record.progress = { task: { taskId: 'new-task', revision: 1, receiptRef: 'new-admission' } };
  current.requests.push(next);
  current.contexts.push({ ...current.contexts[0]!, taskId: 'new-task', state: 'active', requestIds: ['new'] });
  await act(async () => mocks.onRequestKnown!(next));
  expect(element.querySelector('[data-testid="modification-form"]')?.getAttribute('data-request')).toBe('new');
  expect(element.querySelector('select')?.value).toBe('new');
});
