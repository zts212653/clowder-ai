import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reviewDraftPrefix } from '@/components/content-review/useArtifactReview';
import { apiFetch } from '@/utils/api-client';
import { writeShellLanguage } from '../../shell-language';
import { writeShellPresentation } from '../../shell-presentation';
import { createApprovalSessions } from '../approval-sessions';
import { MailboxRow } from '../MailboxRow';
import { collectiveFailure } from './collective-failure.fixture';
import { okRead } from './mailbox-fixtures';
import { REVIEW_OWNER, reviewItem, reviewView } from './mailbox-review-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => () => '小太阳' }));

let root: Root;
let container: HTMLDivElement;
const draftKey = `${reviewDraftPrefix(REVIEW_OWNER, 'review-native')}round:1:decision`;
const pendingKey = `${reviewDraftPrefix(REVIEW_OWNER, 'review-native')}pending`;
let readStarts: number;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  readStarts = 1;
  vi.mocked(apiFetch).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
async function renderReview(readCurrent = true, outage = false) {
  const sessions = createApprovalSessions({
    readsStarted: () => readStarts,
    refetch: vi.fn(),
    refreshStore: async () => {},
    storeItems: () => [],
    attempts: () => ({}),
    latestRead: () => ({
      result: outage
        ? collectiveFailure(okRead([reviewItem()], { identity: { ownerUserId: REVIEW_OWNER } }))
        : okRead([reviewItem()], { identity: { ownerUserId: REVIEW_OWNER } }),
      generation: 1,
    }),
    now: Date.now,
  });
  await act(async () =>
    root.render(
      <MailboxRow
        item={reviewItem()}
        rowKey="native-review"
        stale={!readCurrent}
        expanded={false}
        readCurrent={readCurrent}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        hosted={{ sessions, ownerUserId: REVIEW_OWNER }}
      />,
    ),
  );
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((button) => button.textContent === text);
  expect(found).toBeDefined();
  if (!found) throw new Error(`Missing original decision button: ${text}`);
  return found;
}

it('hosts the original review decision and its explanation even while the v2 row is collapsed', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response(reviewView()));
  await renderReview();
  expect(container.querySelector('textarea[aria-label="审阅结论说明"]')).not.toBeNull();
  expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(
    expect.arrayContaining(['通过此版本', '要求修改']),
  );
  expect(apiFetch).toHaveBeenCalledWith('/api/artifact-reviews/review-native', expect.anything(), expect.anything());
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/media/'))).toBe(false);
});

it('keeps the original English labels and original persistent draft key', async () => {
  writeShellLanguage('en');
  localStorage.setItem(draftKey, JSON.stringify({ body: 'Keep this exact explanation', anchor: null }));
  vi.mocked(apiFetch).mockResolvedValue(response(reviewView()));
  await renderReview();
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review decision explanation"]')?.value,
  ).toBe('Keep this exact explanation');
  expect(button('Approve this version').disabled).toBe(false);
  expect(button('Request changes').disabled).toBe(false);
  expect(container.textContent).toContain('Artwork review');
  expect(container.textContent).not.toContain('你的判断');
});

it.each([
  false,
  true,
])('posts the original revision-bound decision (Collective failure=%s) and shows its canonical result', async (outage) => {
  const initial = reviewView();
  const settled = reviewView();
  settled.review.revision = 6;
  settled.review.rounds[0].state = 'approved';
  settled.review.rounds[0].decision = {
    outcome: 'approved',
    explanation: '',
    actor: { kind: 'human', actorId: REVIEW_OWNER },
    decidedAt: '2026-10-14T12:01:00Z',
    receiptRef: 'receipt:original-review-decision',
  };
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    if (options?.method !== 'POST') return response(initial);
    const { operationId } = JSON.parse(String(options.body)) as { operationId: string };
    return response({
      view: settled,
      receipt: {
        reviewId: settled.review.reviewId,
        operationId,
        revision: settled.review.revision,
        outcome: 'applied',
        receiptRef: 'receipt:original-review-decision',
        actor: { kind: 'human', actorId: REVIEW_OWNER },
        createdAt: '2026-10-14T12:01:00Z',
      },
    });
  });
  await renderReview(true, outage);
  await act(async () => button('通过此版本').click());
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe('/api/artifact-reviews/review-native/actions');
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({
    reviewId: 'review-native',
    expectedRevision: 5,
    expectedTaskRevision: 8,
    round: 1,
    operationId: expect.any(String),
    action: { kind: 'decide', outcome: 'approved', explanation: '' },
  });
  const result = container.querySelector('[data-testid="mailbox-review-result"]');
  expect(result).not.toBeNull();
  expect(result?.textContent).toContain('这版通过');
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

it('checks the live read barrier between drawing a button and pressing it', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response(reviewView()));
  await renderReview();
  readStarts = 2; // A new owner read started without committing another React render yet.
  await act(async () => button('通过此版本').click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it('retains the exact draft and retry operation after a failed write', async () => {
  const saved = { body: 'Make the heading clearer', anchor: null };
  localStorage.setItem(draftKey, JSON.stringify(saved));
  vi.mocked(apiFetch).mockImplementation(async (_url, options) =>
    options?.method === 'POST' ? response({ error: 'unavailable' }, 503) : response(reviewView()),
  );
  await renderReview();
  await act(async () => button('要求修改').click());
  expect(JSON.parse(localStorage.getItem(draftKey) ?? 'null')).toEqual(saved);
  const operation = JSON.parse(localStorage.getItem(pendingKey) ?? 'null').operationId;
  expect(button('要求修改').disabled).toBe(true);
  await act(async () => button('重试这次决定').click());
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes.map(([, options]) => JSON.parse(String(options?.body)).operationId)).toEqual([operation, operation]);
  expect(JSON.parse(localStorage.getItem(draftKey) ?? 'null')).toEqual(saved);
});

it.each([
  'foreign-owner',
  'new-review',
  'read-only',
] as const)('does not mount a writer for a %s original read', async (mismatch) => {
  const view = reviewView();
  if (mismatch === 'foreign-owner') view.review.task.ownerUserId = 'foreign-owner';
  if (mismatch === 'new-review') view.review.revision = 6;
  if (mismatch === 'read-only') view.authority.canWrite = false;
  vi.mocked(apiFetch).mockResolvedValue(response(view));
  await renderReview();
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).not.toContain('通过此版本');
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
