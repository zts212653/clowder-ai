import type { ArtifactReviewCommand, ArtifactReviewView } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NeedsMeOwnerSurface } from '@/components/workbench/GrowingOwnerSurfaces';
import { createWorkspaceModeSurface } from '@/components/workbench/real-surface-adapters';
import { apiFetch } from '@/utils/api-client';
import { ArtifactReviewEntry } from '../ReviewArtifactButton';
import { ReviewHistory } from '../ReviewHistory';
import { reviewDraftPrefix, useArtifactReview } from '../useArtifactReview';
import { useReviewDraft } from '../useReviewDraft';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: () => ({ artifacts: [], loading: false, refetch: vi.fn() }),
}));
vi.mock('@/components/growing/NeedsMePanel', () => ({
  NeedsMePanel: ({ onOpenAction }: { onOpenAction: (actionRef: string, itemRef: string) => void }) =>
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'open-review-action',
        onClick: () => onOpenAction(`content-review:${REVIEW_ID}`, 'needs-me:task-one'),
      },
      '打开',
    ),
}));
const REVIEW_ID = `review-${'a'.repeat(64)}`;
const prefix = reviewDraftPrefix('operator', REVIEW_ID);
const draftKey = `${prefix}round:1:annotation`;
const command: ArtifactReviewCommand = {
  reviewId: REVIEW_ID,
  expectedRevision: 1,
  expectedTaskRevision: 1,
  round: 1,
  operationId: 'stable-save',
  action: {
    kind: 'annotate',
    annotationId: 'mark',
    anchor: { kind: 'image-region', x: 1, y: 1, width: 5, height: 5 },
    body: '同一个人的草稿',
  },
};
const initial: ArtifactReviewView = {
  review: {
    version: 1,
    reviewId: REVIEW_ID,
    revision: 1,
    title: '封面',
    contentRef: 'content-one',
    task: { taskId: 'task-one', threadId: 'thread-one', ownerUserId: 'operator', observedRevision: 1 },
    createdAt: '2026-09-07T14:00:00Z',
    updatedAt: '2026-09-07T14:00:00Z',
    rounds: [
      {
        number: 1,
        openedAt: '2026-09-07T14:00:00Z',
        state: 'draft',
        annotations: [],
        responses: [],
        asset: {
          contentRef: 'content-one',
          ownerRevision: 1,
          blobDigest: `sha256:${'a'.repeat(64)}`,
          mediaType: 'image/png',
          media: { kind: 'image', width: 100, height: 100 },
          ownerReceiptRef: 'receipt:one',
          sourcePublication: { artifactRef: '/uploads/one.png', sourceRef: 'message:thread-one:one', revision: '1' },
        },
      },
    ],
  },
  pendingVersion: false,
  authority: { state: 'current', taskRevision: 1, ownerCatId: 'codex-astra', canWrite: true },
  continuation: {
    taskId: 'task-one',
    expectedRevision: 1,
    artifactRef: 'content:content-one',
    reviewEvidenceRef: 'review:one',
    ownerCatId: 'codex-astra',
  },
};
let controller: ReturnType<typeof useArtifactReview>;
let draftBody = '';
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
function DraftProbe() {
  const draft = useReviewDraft(draftKey);
  draftBody = draft.draft.body;
  return null;
}
function Probe() {
  controller = useArtifactReview(REVIEW_ID);
  return controller.view
    ? createElement(
        'div',
        null,
        createElement(DraftProbe),
        createElement(ReviewHistory, {
          reviewId: REVIEW_ID,
          revision: controller.view.review.revision,
          ownerUserId: 'operator',
        }),
      )
    : null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

it('a successful replay clears the already committed draft in storage and mounted state, preventing accidental duplicate resubmission', async () => {
  localStorage.setItem(`${prefix}pending`, JSON.stringify(command));
  localStorage.setItem(
    draftKey,
    JSON.stringify({
      body: '同一个人的草稿',
      anchor: command.action.kind === 'annotate' ? command.action.anchor : null,
    }),
  );
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'POST'
      ? response({ view: { ...initial, review: { ...initial.review, revision: 2 } } })
      : response(initial),
  );
  await act(async () => {
    root.render(createElement(Probe));
  });
  expect(draftBody).toBe('同一个人的草稿');
  await act(async () => {
    expect(await controller.retry()).toBe(true);
  });
  expect(localStorage.getItem(draftKey)).toBeNull();
  expect(draftBody).toBe('');
  const sent = vi.mocked(apiFetch).mock.calls.find((call) => call[1]?.method === 'POST')?.[1];
  expect(new Headers(sent?.headers).get('content-type')).toBe('application/json');
  expect(
    JSON.parse(String(vi.mocked(apiFetch).mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body)),
  ).toEqual(command);
});

it('a late read cannot overwrite the newer revision acknowledged by a successful write', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response(initial));
  await act(async () => {
    root.render(createElement(Probe));
  });
  let resolveRead: (response: Response) => void = () => undefined;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'POST'
      ? response({ view: { ...initial, review: { ...initial.review, revision: 2 } } })
      : new Promise<Response>((resolve) => {
          resolveRead = resolve;
        }),
  );
  let reading: Promise<void>;
  await act(async () => {
    reading = controller.refresh();
  });
  await act(async () => {
    expect(await controller.act(command.action, 1)).toBe(true);
  });
  await act(async () => {
    resolveRead(response(initial));
    await reading;
  });
  expect(controller.view?.review.revision).toBe(2);
});

async function mountRetainedReview() {
  localStorage.setItem(draftKey, JSON.stringify({ body: '尚未提交的意见', anchor: null }));
  localStorage.setItem(`${prefix}pending`, JSON.stringify(command));
  const onOpen = vi.fn();
  vi.mocked(apiFetch).mockResolvedValue(response(initial));
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        createElement('div', { hidden: true }, createElement(Probe)),
        createElement(NeedsMeOwnerSurface, {
          surface: createWorkspaceModeSurface('needs-me', 'thread-one'),
          onOpenArtifactWithReturn: onOpen,
          onOpenSurface: vi.fn(),
          onRefreshSurface: vi.fn(),
        }),
      ),
    );
  });
  return onOpen;
}

it.each([
  401, 403, 404, 410,
])('a denied Needs Me open (%i) clears the retained review and refreshes its owner projection', async (status) => {
  const onOpen = await mountRetainedReview();
  const unrelatedKey = `${reviewDraftPrefix('operator', 'other-review')}round:1:annotation`;
  localStorage.setItem(unrelatedKey, 'another review draft');
  const invalidated = vi.fn();
  window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', invalidated);
  try {
    vi.mocked(apiFetch).mockResolvedValue(response({ error: 'access_denied' }, status));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-review-action"]')?.click());
    expect(onOpen).not.toHaveBeenCalled();
    expect(container.textContent).toContain('这份内容已更新或暂时不可用');
    expect(controller.view).toBeNull();
    expect(controller.pending).toBeNull();
    expect(localStorage.getItem(draftKey)).toBeNull();
    expect(localStorage.getItem(`${prefix}pending`)).toBeNull();
    expect(localStorage.getItem(unrelatedKey)).toBe('another review draft');
    expect(invalidated).toHaveBeenCalledOnce();
    expect(vi.mocked(apiFetch).mock.calls.at(-1)?.[2]).toEqual({ afterCurrentGet: true });
  } finally {
    window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', invalidated);
  }
});

it('a temporary Needs Me read failure keeps the draft and permits a later authorized open', async () => {
  const onOpen = await mountRetainedReview();
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'media_unavailable' }, 503));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-review-action"]')?.click());
  expect(onOpen).not.toHaveBeenCalled();
  expect(controller.view).not.toBeNull();
  expect(localStorage.getItem(draftKey)).toContain('尚未提交的意见');
  expect(localStorage.getItem(`${prefix}pending`)).not.toBeNull();
  vi.mocked(apiFetch).mockResolvedValue(response(initial));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-review-action"]')?.click());
  expect(onOpen).toHaveBeenCalledOnce();
});

it('a denial on the mounted reader refreshes Needs Me as well as removing review data', async () => {
  await mountRetainedReview();
  const invalidated = vi.fn();
  window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', invalidated);
  try {
    vi.mocked(apiFetch).mockResolvedValue(response({ error: 'access_denied' }, 403));
    await act(async () => controller.refresh());
    expect(controller.view).toBeNull();
    expect(localStorage.getItem(draftKey)).toBeNull();
    expect(invalidated).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', invalidated);
  }
});

it('an aborted old denial cannot erase a newer authorized read or its draft', async () => {
  await mountRetainedReview();
  let finishOldRead: (response: Response) => void = () => undefined;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishOldRead = resolve;
      }),
  );
  let oldRead: Promise<void>;
  await act(async () => {
    oldRead = controller.refresh();
  });
  vi.mocked(apiFetch).mockResolvedValue(response(initial));
  await act(async () => controller.refresh());
  await act(async () => {
    finishOldRead(response({ error: 'access_denied' }, 403));
    await oldRead;
  });
  expect(controller.view).not.toBeNull();
  expect(localStorage.getItem(draftKey)).toContain('尚未提交的意见');
});

it.each([
  'first',
  'next',
])('a definite denial on the %s history page clears the retained discussion and draft', async (page) => {
  await mountRetainedReview();
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path.includes('/history') ? response({ entries: [], nextCursor: 2 }) : response(initial),
  );
  if (page === 'first') vi.mocked(apiFetch).mockResolvedValue(response({ error: 'access_denied' }, 403));
  await act(async () => {
    const details = container.querySelector('details');
    if (!details) throw new Error('Expected actual review history');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  if (page === 'next') {
    vi.mocked(apiFetch).mockResolvedValue(response({ error: 'access_denied' }, 403));
    await act(async () => container.querySelector<HTMLButtonElement>('details button')?.click());
  }
  expect(controller.view).toBeNull();
  expect(container.querySelector('details')).toBeNull();
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it('a denied prepare rechecks retained reviews and clears inaccessible draft content', async () => {
  localStorage.setItem(draftKey, JSON.stringify({ body: '尚未提交的意见', anchor: null }));
  let revoked = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path.includes('/context?'))
      return response({
        contexts: [
          {
            taskId: 'task-one',
            title: '封面',
            expectedTaskRevision: 1,
            artifactRef: '/uploads/one.png',
            expectedArtifactRevision: '1',
          },
        ],
      });
    if (path.endsWith('/prepare')) revoked = true;
    return revoked ? response({ error: 'access_denied' }, 403) : response(initial);
  });
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement(Probe),
        createElement(ArtifactReviewEntry, {
          artifactRef: '/uploads/one.png',
          threadId: 'thread-one',
          onPrepared: vi.fn(),
        }),
      ),
    ),
  );
  expect(controller.view).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-artifact-review"]')?.click());
  expect(controller.view).toBeNull();
  expect(localStorage.getItem(draftKey)).toBeNull();
});
