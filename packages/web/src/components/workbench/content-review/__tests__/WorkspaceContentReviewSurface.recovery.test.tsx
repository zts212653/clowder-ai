import type { WorkspaceContentReviewView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFileMenu } from '@/test-utils/open-file-menu';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { workspaceReviewDraftKey } from '../workspace-review-draft';
import { discussionView, mediaView, replyView, reviewId, view } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.apiFetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(view()));
    if (url === `/api/workspace/content-reviews/${reviewId}/annotations`)
      return new Response(JSON.stringify({ review: view(true).review }));
    if (url === `/api/workspace/content-reviews/${reviewId}`) return new Response(JSON.stringify(view(true)));
    throw new Error(`unexpected route: ${url} ${init?.method ?? 'GET'}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** New image discussion goes to Chat; a persisted unknown annotation still owns its retry. */
function seedPendingMediaAnnotation(body: string, operationId = 'pending-original-operation') {
  localStorage.setItem(
    workspaceReviewDraftKey(mediaView()),
    JSON.stringify({
      v: 1,
      body,
      target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 32, y: 48 } },
      activeAnnotationId: null,
      annotation: {
        operationId,
        expectedRevision: 1,
        body,
        target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 32, y: 48 } },
      },
      action: null,
      refresh: null,
    }),
  );
}
async function renderMedia() {
  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path="cover.png"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    );
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}
const retryAnnotation = async () => {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '核对并重试保存');
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};

it('reuses an annotation operation id after an unknown write result instead of creating a duplicate comment', async () => {
  let annotationAttempts = 0;
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(mediaView()));
    if (url === `/api/workspace/content-reviews/${reviewId}/annotations`) {
      annotationAttempts += 1;
      if (annotationAttempts === 1) throw new Error('response lost after server commit');
      return new Response(JSON.stringify({ review: discussionView().review }));
    }
    if (url === `/api/workspace/content-reviews/${reviewId}`) return new Response(JSON.stringify(mediaView()));
    if (url.startsWith(`/api/workspace/content-reviews/${reviewId}/operations/`))
      return new Response(JSON.stringify({ receipt: null }));
    throw new Error(`unexpected route: ${url}`);
  });
  seedPendingMediaAnnotation('Please clarify this frame.');
  await renderMedia();
  await retryAnnotation();
  await retryAnnotation();

  const calls = mocks.apiFetch.mock.calls.filter(
    ([url]) => url === `/api/workspace/content-reviews/${reviewId}/annotations`,
  );
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[0]?.[1]?.body)).operationId).toBe('pending-original-operation');
  expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual(JSON.parse(String(calls[0]?.[1]?.body)));
});

it('reconciles an unknown annotation response from the persisted operation identity', async () => {
  const operationId = 'operation-confirmed-after-response-loss';
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId);
  const confirmed = discussionView();
  confirmed.review.annotations = confirmed.review.annotations.map((annotation) => ({ ...annotation, operationId }));
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(mediaView()));
    if (url === `/api/workspace/content-reviews/${reviewId}/annotations`)
      throw new Error('response lost after server commit');
    if (url === `/api/workspace/content-reviews/${reviewId}`) return new Response(JSON.stringify(confirmed));
    throw new Error(`unexpected route: ${url}`);
  });
  seedPendingMediaAnnotation('Please review this ordinary file.', operationId);
  await renderMedia();
  await retryAnnotation();

  expect(
    mocks.apiFetch.mock.calls.filter(([url]) => url === `/api/workspace/content-reviews/${reviewId}/annotations`),
  ).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(workspaceReviewDraftKey(mediaView())) ?? '{}')).toMatchObject({
    body: '',
    annotation: null,
  });
  expect(container.textContent).toContain('批注已从操作记录确认保存。');
});

it('reconciles a committed unknown reply action by refreshing the durable review state', async () => {
  const initial = discussionView();
  let committed: WorkspaceContentReviewView | undefined;
  let committedOperation = '';
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(initial));
    if (url === `/api/workspace/content-reviews/${reviewId}/actions`) {
      const request = JSON.parse(String(init?.body)) as {
        operationId: string;
        action: { kind: 'reply'; annotationId: string; replyId: string; body: string };
      };
      committedOperation = request.operationId;
      committed = replyView(initial, request.action.replyId, request.action.body);
      throw new Error('response lost after server commit');
    }
    if (url === `/api/workspace/content-reviews/${reviewId}`) return new Response(JSON.stringify(committed ?? initial));
    if (url === `/api/workspace/content-reviews/${reviewId}/operations/${committedOperation}`)
      return new Response(
        JSON.stringify({
          receipt: {
            reviewId,
            operationId: committedOperation,
            revision: committed?.review.revision,
            receiptRef: 'owner-receipt',
            actor: { kind: 'human', actorId: 'operator' },
            createdAt: '2026-09-20T00:00:00.000Z',
            replayed: true,
          },
        }),
      );
    throw new Error(`unexpected route: ${url}`);
  });
  await renderDiscussionSurface();
  const textarea = replyTextarea();
  await setTextInput(textarea, 'The committed reply must be reconciled without leaving this review.');
  await act(async () => replyButton()?.click());
  await settle();

  expect(actionRequests()).toHaveLength(1);
  expect(container.textContent).toContain('The committed reply must be reconciled without leaving this review.');
  expect(replyTextarea().value).toBe('');
});

it('retries an unconfirmed reply with its original operation and reply identity', async () => {
  const initial = discussionView();
  let attempts = 0;
  let saved: WorkspaceContentReviewView | undefined;
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(initial));
    if (url === `/api/workspace/content-reviews/${reviewId}/actions`) {
      attempts += 1;
      const request = JSON.parse(String(init?.body)) as {
        action: { kind: 'reply'; annotationId: string; replyId: string; body: string };
      };
      if (attempts === 1) throw new Error('connection closed before the server accepted the action');
      saved = replyView(initial, request.action.replyId, request.action.body);
      return new Response(JSON.stringify({}));
    }
    if (url === `/api/workspace/content-reviews/${reviewId}`) return new Response(JSON.stringify(saved ?? initial));
    throw new Error(`unexpected route: ${url}`);
  });
  await renderDiscussionSurface();
  const textarea = replyTextarea();
  await setTextInput(textarea, 'Retry this reply with the same durable action identity.');
  await act(async () => replyButton()?.click());
  await settle();
  await act(async () => replyButton()?.click());
  await settle();

  const [first, second] = actionRequests().map(([, init]) => JSON.parse(String(init?.body)));
  expect(first?.operationId).toBe(second?.operationId);
  expect(first?.expectedRevision).toBe(second?.expectedRevision);
  expect(first?.action.replyId).toBe(second?.action.replyId);
  expect(container.textContent).toContain('Retry this reply with the same durable action identity.');
});

it('keeps an acknowledged reply identity when its first read-back is unavailable', async () => {
  const initial = discussionView();
  let reads = 0;
  let saved: WorkspaceContentReviewView | undefined;
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(initial));
    if (url === `/api/workspace/content-reviews/${reviewId}/actions`) {
      const request = JSON.parse(String(init?.body)) as {
        action: { kind: 'reply'; annotationId: string; replyId: string; body: string };
      };
      saved = replyView(initial, request.action.replyId, request.action.body);
      return new Response(JSON.stringify({}));
    }
    if (url === `/api/workspace/content-reviews/${reviewId}`) {
      reads += 1;
      if (reads < 3) throw new Error('read-back unavailable after action receipt');
      return new Response(JSON.stringify(saved ?? initial));
    }
    throw new Error(`unexpected route: ${url}`);
  });
  await renderDiscussionSurface();
  const textarea = replyTextarea();
  await setTextInput(textarea, 'Keep the original receipt through a read-back failure.');
  await act(async () => replyButton()?.click());
  await settle();
  await act(async () => replyButton()?.click());
  await settle();

  const [first, second] = actionRequests().map(([, init]) => JSON.parse(String(init?.body)));
  expect(first?.operationId).toBe(second?.operationId);
  expect(first?.action.replyId).toBe(second?.action.replyId);
  expect(container.textContent).toContain('Keep the original receipt through a read-back failure.');
});

async function renderDiscussionSurface() {
  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path="cover.png"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await openFileMenu(container);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开作品讨论"]')?.click());
}

function replyTextarea() {
  const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="回复批注 ordinary-action-comment"]');
  if (!textarea) throw new Error('ordinary discussion reply input is missing');
  return textarea;
}

async function setTextInput(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function replyButton() {
  return [...container.querySelectorAll('button')].find((button) => button.textContent === '回复');
}

function actionRequests() {
  return mocks.apiFetch.mock.calls.filter(([url]) => url === `/api/workspace/content-reviews/${reviewId}/actions`);
}

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
