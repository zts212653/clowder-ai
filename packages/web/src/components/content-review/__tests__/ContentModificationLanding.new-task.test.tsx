import type {
  ContentModificationContextCatalogue,
  ContentModificationRequest,
  ContentModificationRequestView,
} from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationLanding } from '../ContentModificationLanding';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  onRequestKnown: undefined as ((request: ContentModificationRequestView) => void) | undefined,
}));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../ContentModificationPanel', () => ({
  ContentModificationPanel: (props: { onRequestKnown?: (request: ContentModificationRequestView) => void }) => {
    mocks.onRequestKnown = props.onRequestKnown;
    return <div data-testid="modification-form" />;
  },
}));

const fileSource: ContentModificationRequest['source'] = {
  kind: 'workspace',
  locator: { worktreeId: 'work', path: 'desserts.md' },
  expectedSourceRevision: `sha256:${'b'.repeat(64)}`,
  reviewId: 'file-review',
  expectedReviewRevision: 1,
};
const request: ContentModificationRequestView = {
  stage: 'queued',
  record: {
    requestId: 'two',
    ownerUserId: 'operator',
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    progress: { task: { taskId: 'task-two', revision: 1, receiptRef: 'task-two#created' } },
    payload: {
      operationId: 'op-two',
      source: fileSource,
      targetCatId: 'sonnet',
      threadId: 'thread-two',
      intent: { body: '加一项焦糖布丁' },
    },
  },
} as ContentModificationRequestView;
const empty: ContentModificationContextCatalogue = { requests: [], contexts: [] };
const withTask: ContentModificationContextCatalogue = {
  requests: [request],
  contexts: [
    {
      taskId: 'task-two',
      title: 'desserts.md',
      targetCatId: 'sonnet',
      threadId: 'thread-two',
      targetName: '布偶猫（Sonnet）',
      threadTitle: 'thread-two',
      requestIds: ['two'],
      state: 'active',
      taskContext: { kind: 'text', taskId: 'task-two', expectedTaskRevision: 1 },
    },
  ],
};

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let current: ContentModificationContextCatalogue;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
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

// Real page 2026-09-23: a first request on desserts.md was handed to Sonnet and its run
// failed. The catalogue had been read before the request existed, so its Task context was
// never known and "沿原委托继续修改" only appeared after a reload.
it('re-reads the catalogue once when a request gains a Task the catalogue has not seen', async () => {
  current = empty;
  await act(async () =>
    root.render(
      <ContentModificationLanding source={fileSource} ownerUserId="operator" title="desserts.md" onClose={() => {}} />,
    ),
  );
  const reads = () => mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/content-modifications/context').length;
  const before = reads();

  current = withTask;
  await act(async () => mocks.onRequestKnown!(request));
  expect(reads()).toBe(before + 1);
  expect(element.querySelector('[data-testid="content-modification-continue"]')).not.toBeNull();

  // Once the context is known, further reports of the same request do not re-read.
  await act(async () => mocks.onRequestKnown!(request));
  await act(async () => mocks.onRequestKnown!(request));
  expect(reads()).toBe(before + 1);
});
