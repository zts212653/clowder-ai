import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceContentReview } from '../useWorkspaceContentReview';
import { reconcileActionFailure } from '../workspace-review-action-recovery';
import { workspaceReviewDraftKey } from '../workspace-review-draft';
// The annotation retry machinery stays live for media; text annotations now go to chat (CVO095/098).
import { discussionView, reviewId, mediaView as view } from './WorkspaceContentReviewSurface.fixture';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => api.fetch(...args) }));
let root: Root, container: HTMLDivElement, model: ReturnType<typeof useWorkspaceContentReview>;
function Probe({ path = 'cover.png' }: { path?: string }) {
  model = useWorkspaceContentReview({ worktreeId: 'worktree-a', path });
  return <span>{model.view?.review.contentRef}</span>;
}
async function mount(path = 'cover.png') {
  await act(async () => {
    root.render(<Probe path={path} />);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
async function remount() {
  act(() => root.unmount());
  root = createRoot(container);
  await mount();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  api.fetch.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
const target = { kind: 'media_anchor' as const, anchor: { kind: 'image-point' as const, x: 32, y: 48 } };

it('restores an unsent body and its exact selection after a fresh owner read on remount', async () => {
  api.fetch.mockResolvedValue(new Response(JSON.stringify(view())));
  api.fetch.mockImplementation(async () => new Response(JSON.stringify(view())));
  await mount();
  await act(async () => {
    model.setDraft('尚未发出的原意图');
    model.setTarget(target);
  });
  await remount();
  expect(model.draft).toBe('尚未发出的原意图');
  expect(model.target).toEqual(target);
  expect(api.fetch.mock.calls.every(([url]) => url.endsWith('/prepare'))).toBe(true);
});

it('does not infer that its state-changing action succeeded just because another actor left the same state', async () => {
  const saved = discussionView();
  saved.review.annotations[0]!.state = 'resolved';
  api.fetch.mockResolvedValue(new Response(JSON.stringify({ receipt: null })));
  const pending = {
    operationId: 'unconfirmed-operation',
    expectedRevision: saved.review.revision,
    actionKey: 'state',
    action: {
      kind: 'set_annotation_state' as const,
      annotationId: saved.review.annotations[0]!.id,
      state: 'resolved' as const,
    },
  };
  expect(
    await reconcileActionFailure(async () => saved, reviewId, pending, false, '/api/workspace/content-reviews'),
  ).toBe('retry');
});

it('keeps the exact pending annotation operation and expected revision after unknown response and reload', async () => {
  let first = true;
  api.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/annotations')) {
      first = false;
      throw new Error('unknown write');
    }
    const snapshot = view();
    if (!first) snapshot.review.revision = 2;
    return new Response(JSON.stringify(snapshot));
  });
  await mount();
  await act(async () => {
    model.setDraft('Keep this request');
    model.setTarget(target);
  });
  await act(async () => model.submitAnnotation());
  const submitted = api.fetch.mock.calls.find(([url]) => url.endsWith('/annotations'))?.[1];
  await remount();
  expect(model.draft).toBe('Keep this request');
  await act(async () => model.submitAnnotation());
  const writes = api.fetch.mock.calls.filter(([url]) => url.endsWith('/annotations'));
  expect(writes).toHaveLength(2);
  expect(JSON.parse(String(writes[1]?.[1]?.body))).toEqual(JSON.parse(String(submitted?.body)));
  expect(JSON.parse(String(writes[1]?.[1]?.body)).expectedRevision).toBe(1);
});

it('ignores a late response from the previous content coordinate', async () => {
  let release!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fresh = view();
  fresh.review.reviewId = 'new-review';
  fresh.review.contentRef = 'workspace-content:new';
  api.fetch.mockImplementation(async (_url: string, init: RequestInit) =>
    JSON.parse(String(init.body)).locator.path === 'cover.png' ? old : new Response(JSON.stringify(fresh)),
  );
  await mount();
  await mount('other.md');
  expect(model.view?.review.reviewId).toBe('new-review');
  await act(async () => {
    release(new Response(JSON.stringify(view())));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  expect(model.view?.review.reviewId).toBe('new-review');
  expect(model.view?.review.reviewId).not.toBe(reviewId);
});

it('keeps text typed while the previous annotation receipt is in flight', async () => {
  let release!: (response: Response) => void;
  api.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/annotations')
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : new Response(JSON.stringify(view())),
  );
  await mount();
  await act(async () => {
    model.setDraft('submitted body');
    model.setTarget(target);
  });
  let pending!: Promise<void>;
  act(() => {
    pending = model.submitAnnotation();
  });
  await act(async () => model.setDraft('a later unsent thought'));
  await act(async () => {
    release(new Response(JSON.stringify({})));
    await pending;
  });
  expect(model.draft).toBe('a later unsent thought');
  expect(model.target).toEqual(target);
  await remount();
  expect(model.draft).toBe('a later unsent thought');
});

// Sol #4747 R3 P1: the receipt must settle against this tab's newer body even when writing that body failed,
// because storage still holds only what this tab last wrote (the old pending body).
async function submitThenTypeWhileStorageRefuses() {
  let release!: (response: Response) => void;
  api.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/annotations')
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : new Response(JSON.stringify(view())),
  );
  await mount();
  await act(async () => {
    model.setDraft('submitted body');
    model.setTarget(target);
  });
  let pending!: Promise<void>;
  act(() => {
    pending = model.submitAnnotation();
  });
  const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
  await act(async () => model.setDraft('a later unsent thought'));
  refuse.mockRestore();
  const stored = () => JSON.parse(localStorage.getItem(workspaceReviewDraftKey(view())) ?? 'null');
  expect(stored().body).toBe('submitted body');
  expect(stored().annotation?.body).toBe('submitted body');
  return { stored, settle: (response: Response) => act(async () => (release(response), await pending)) };
}

it('a receipt keeps a newer body whose own write failed, and records it once storage accepts writes', async () => {
  const { stored, settle } = await submitThenTypeWhileStorageRefuses();
  await settle(new Response(JSON.stringify({})));
  expect(model.draft).toBe('a later unsent thought');
  expect(model.target).toEqual(target);
  expect(stored().body).toBe('a later unsent thought');
  expect(stored().annotation).toBeNull();
  await remount();
  expect(model.draft).toBe('a later unsent thought');
});

it('a receipt that finds both another tab’s write and this tab’s unsaved body changes neither', async () => {
  const { stored, settle } = await submitThenTypeWhileStorageRefuses();
  const otherTab = { ...stored(), body: 'written in another tab' };
  localStorage.setItem(workspaceReviewDraftKey(view()), JSON.stringify(otherTab));
  await settle(new Response(JSON.stringify({})));
  expect(model.draft).toBe('a later unsent thought');
  expect(stored()).toEqual(otherTab);
});

it('restores an unconfirmed reply with its operation, reply identity and original expected revision', async () => {
  let attempts = 0;
  api.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/actions')) {
      if (++attempts === 1) throw new Error('lost response');
      return new Response('{}');
    }
    if (url.includes('/operations/')) return new Response(JSON.stringify({ receipt: null }));
    return new Response(JSON.stringify(view()));
  });
  await mount();
  const action = {
    kind: 'reply' as const,
    annotationId: 'a-comment',
    replyId: 'first-reply',
    body: 'retain reply identity',
  };
  await act(async () => model.act(action));
  await remount();
  expect(model.pending).toBe(true);
  await act(async () => model.act({ ...action, replyId: 'new-render-id' }));
  const writes = api.fetch.mock.calls
    .filter(([url]) => url.endsWith('/actions'))
    .map(([, init]) => JSON.parse(String(init.body)));
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

it('does not transmit an operation when its durable retry record cannot be stored', async () => {
  api.fetch.mockImplementation(async () => new Response(JSON.stringify(view())));
  await mount();
  await act(async () => {
    model.setDraft('keep in memory');
    model.setTarget(target);
  });
  const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  try {
    await act(async () => model.submitAnnotation());
    expect(model.draft).toBe('keep in memory');
    expect(model.error).toContain('存储');
    expect(api.fetch.mock.calls.some(([url]) => url.endsWith('/annotations'))).toBe(false);
  } finally {
    failure.mockRestore();
  }
});

it('preserves an unreadable existing retry record and refuses to replace it with a new request', async () => {
  const key = workspaceReviewDraftKey(view());
  localStorage.setItem(key, 'unreadable-existing-record');
  api.fetch.mockImplementation(async () => new Response(JSON.stringify(view())));
  await mount();
  await act(async () => {
    model.setDraft('new thought');
    model.setTarget(target);
  });
  await act(async () => model.submitAnnotation());
  expect(localStorage.getItem(key)).toBe('unreadable-existing-record');
  expect(api.fetch.mock.calls.some(([url]) => url.endsWith('/annotations'))).toBe(false);
});

it('releases a rejected annotation operation only after the owner confirms no receipt, preserving the draft', async () => {
  let attempts = 0;
  api.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/annotations'))
      return ++attempts === 1 ? new Response('{}', { status: 409 }) : new Response('{}');
    if (url.includes('/operations/')) return new Response(JSON.stringify({ receipt: null }));
    const snapshot = view();
    if (attempts) snapshot.review.revision = 2;
    return new Response(JSON.stringify(snapshot));
  });
  await mount();
  await act(async () => {
    model.setDraft('Retain after conflict');
    model.setTarget(target);
  });
  await act(async () => model.submitAnnotation());
  expect(model.pending).toBe(false);
  expect(model.draft).toBe('Retain after conflict');
  await act(async () => model.submitAnnotation());
  const writes = api.fetch.mock.calls
    .filter(([url]) => url.endsWith('/annotations'))
    .map(([, init]) => JSON.parse(String(init.body)));
  expect(writes[1].operationId).not.toBe(writes[0].operationId);
  expect(writes[1].expectedRevision).toBe(2);
});

it('refreshes this ledger on an owner change event without discarding an unsent selection', async () => {
  let current = view();
  api.fetch.mockImplementation(async () => new Response(JSON.stringify(current)));
  await mount();
  await act(async () => {
    model.setDraft('still composing');
    model.setTarget(target);
  });
  current = discussionView();
  await act(async () => {
    window.dispatchEvent(new CustomEvent('cat-cafe:artifact-review-changed', { detail: { reviewId } }));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  expect(model.view?.review.revision).toBe(2);
  expect(model.draft).toBe('still composing');
  expect(model.target).toEqual(target);
  expect(api.fetch.mock.calls.some(([url]) => url === `/api/workspace/content-reviews/${reviewId}`)).toBe(true);
});

it('does not regress the ledger when an older refresh finishes after a newer owner read', async () => {
  let reads = 0,
    release!: (response: Response) => void;
  api.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/prepare')) return new Response(JSON.stringify(view()));
    if (++reads === 1)
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    const latest = view();
    latest.review.revision = 3;
    return new Response(JSON.stringify(latest));
  });
  await mount();
  const changed = () =>
    window.dispatchEvent(new CustomEvent('cat-cafe:artifact-review-changed', { detail: { reviewId } }));
  await act(async () => {
    changed();
    await Promise.resolve();
  });
  await act(async () => {
    changed();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  expect(model.view?.review.revision).toBe(3);
  await act(async () => {
    release(new Response(JSON.stringify(discussionView())));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  expect(model.view?.review.revision).toBe(3);
});
