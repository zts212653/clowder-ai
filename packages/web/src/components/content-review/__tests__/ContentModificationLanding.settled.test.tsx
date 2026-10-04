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
  locator: { worktreeId: 'work', path: 'drinks.md' },
  expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
  reviewId: 'file-review',
  expectedReviewRevision: 1,
};
const control = {
  state: 'cancelled' as const,
  actorId: 'operator',
  cancelledAt: 1,
  receiptRef: 'cancelled-one',
  taskResolution: 'closed' as const,
};
function catalogue(contextState: 'active' | 'closed'): ContentModificationContextCatalogue {
  return {
    requests: [
      {
        stage: 'cancelled',
        record: {
          requestId: 'one',
          ownerUserId: 'operator',
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
          progress: {},
          control,
          payload: {
            operationId: 'op-one',
            source: fileSource,
            targetCatId: 'codex-sol',
            threadId: 'thread-one',
            intent: { body: '加一项' },
          },
        },
      },
    ],
    contexts: [
      {
        taskId: 'task-one',
        title: 'drinks.md',
        targetCatId: 'codex-sol',
        threadId: 'thread-one',
        targetName: '缅因猫',
        threadTitle: 'thread-one',
        requestIds: ['one'],
        state: contextState,
      },
    ],
  };
}

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

// Dogfood 2026-09-22: after cancelling, the catalogue was re-read while the Task was
// still closing. By the time the Task closed, the request's control no longer changed,
// so nothing re-read the catalogue and "发起新的修改请求" only appeared after a reload.
it('re-reads the catalogue once when a settled request still shows an open Task context', async () => {
  current = catalogue('active');
  await act(async () =>
    root.render(
      <ContentModificationLanding source={fileSource} ownerUserId="operator" title="drinks.md" onClose={() => {}} />,
    ),
  );
  expect(element.querySelector('[data-testid="content-modification-new-request"]')).toBeNull();
  const reads = () => mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/content-modifications/context').length;
  const before = reads();

  current = catalogue('closed');
  const settled: ContentModificationRequestView = { ...current.requests[0]!, execution: undefined };
  await act(async () => mocks.onRequestKnown!(settled));
  expect(element.querySelector('[data-testid="content-modification-new-request"]')).not.toBeNull();
  expect(reads()).toBe(before + 1);

  // A settled request is re-checked at most once; later identical reports do not loop.
  await act(async () => mocks.onRequestKnown!(settled));
  await act(async () => mocks.onRequestKnown!(settled));
  expect(reads()).toBe(before + 1);
});
