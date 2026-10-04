import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { UNIFIED_ATTENTION_PATH, type UnifiedAttentionView, useUnifiedAttention } from '../use-unified-attention';

const source = (overrides: Record<string, unknown> = {}) => ({
  status: 'available',
  startedAt: 1,
  observedAt: 2,
  coverage: 'all_registered_F246_producers',
  exhaustiveness: 'complete',
  ...overrides,
});

function readBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner-1' },
    observedAt: 3,
    sources: { approvals: source(), needsMe: source({ coverage: 'current_linked_F310_five_producers' }) },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [{ decisionRef: 'approval:F309:p1', kind: 'approval', summary: '一件', linkedNeedsMe: [] }],
    totalCount: 1,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  };
}

interface Deferred {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (reason: unknown) => void;
}
function deferred(): Deferred {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Routes the two GETs the hook makes; the unified one is supplied per test, the session defaults to owner-1. */
function route(
  unified: () => Promise<Response>,
  session: () => Promise<Response> = () => Promise.resolve(Response.json({ userId: 'owner-1' })),
) {
  mocks.apiFetch.mockImplementation((path: string) => (path === '/api/session' ? session() : unified()));
}

let latest: UnifiedAttentionView;
function Harness() {
  latest = useUnifiedAttention();
  return null;
}

describe('useUnifiedAttention — one verified read of the owner’s attention', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const mount = async () => act(async () => root.render(<Harness />));
  const fire = async (name: string) => act(async () => void window.dispatchEvent(new CustomEvent(name)));

  it('asks for exactly the first unified page and reports the verified read', async () => {
    route(() => Promise.resolve(Response.json(readBody())));
    await mount();

    expect(UNIFIED_ATTENTION_PATH).toBe('/api/concierge/work/decisions?view=unified&offset=0&limit=20');
    expect(mocks.apiFetch).toHaveBeenCalledWith(UNIFIED_ATTENTION_PATH, expect.anything(), { afterCurrentGet: true });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/session', expect.anything());
    expect(latest.result.kind).toBe('ok');
    expect(latest.staleRead).toBeNull();
  });

  it('is loading until the first read settles — never an empty or zero claim', async () => {
    const pending = deferred();
    route(() => pending.promise);
    await mount();
    expect(latest.result).toEqual({ kind: 'loading' });

    await act(async () => pending.resolve(Response.json(readBody())));
    expect(latest.result.kind).toBe('ok');
  });

  it('refuses rows whose owner is not the signed-in session', async () => {
    route(
      () => Promise.resolve(Response.json(readBody())),
      () => Promise.resolve(Response.json({ userId: 'someone-else' })),
    );
    await mount();
    expect(latest.result).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(latest.staleRead).toBeNull();
  });

  it('cannot verify identity when the session read fails, so it shows nothing', async () => {
    route(
      () => Promise.resolve(Response.json(readBody())),
      () => Promise.resolve(new Response('{}', { status: 500 })),
    );
    await mount();
    expect(latest.result).toEqual({ kind: 'failed', reason: 'unavailable' });
  });

  it('maps only a route-level 401 to needs-login; 403 and 5xx are unavailable', async () => {
    route(() => Promise.resolve(new Response('{}', { status: 401 })));
    await mount();
    expect(latest.result).toEqual({ kind: 'failed', reason: 'unauthenticated' });

    route(() => Promise.resolve(new Response('{}', { status: 403 })));
    await act(async () => latest.refetch());
    expect(latest.result).toEqual({ kind: 'failed', reason: 'unavailable' });

    route(() => Promise.resolve(new Response('{}', { status: 500 })));
    await act(async () => latest.refetch());
    expect(latest.result).toEqual({ kind: 'failed', reason: 'unavailable' });
  });

  it('keeps the structured 503 (all sources unavailable) as a read so each source can be named', async () => {
    route(() =>
      Promise.resolve(
        Response.json(
          readBody({
            status: 'unavailable',
            items: [],
            totalCount: undefined,
            sources: {
              approvals: source({ status: 'unauthenticated', exhaustiveness: 'unknown' }),
              needsMe: source({ status: 'unauthenticated', exhaustiveness: 'unknown' }),
            },
          }),
          { status: 503 },
        ),
      ),
    );
    await mount();
    expect(latest.result.kind).toBe('ok');
  });

  it.each([
    ['a 503 with no structured body', () => Promise.resolve(new Response('upstream down', { status: 503 }))],
    [
      // A runtime that predates the unified view rejects `view=unified` with 400 (F310 delivery record: live 3002 until restart).
      'a 400 from an API that does not know the unified view yet',
      () => Promise.resolve(Response.json({ error: 'Invalid decision page' }, { status: 400 })),
    ],
    ['a 200 whose body is another version', () => Promise.resolve(Response.json(readBody({ version: 2 })))],
    ['a 200 that is not JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('treats %s as unavailable, never as an empty success', async (_label, unified) => {
    route(unified);
    await mount();
    expect(latest.result).toEqual({ kind: 'failed', reason: 'unavailable' });
  });

  it.each([
    'cat-cafe:proposal-updated',
    'cat-cafe:proposal-created',
    'cat-cafe:runtime-interaction-updated',
    'cat-cafe:entrusted-work-projection-invalidated',
  ])('re-reads on %s from the original invalidation chain', async (eventName) => {
    route(() => Promise.resolve(Response.json(readBody())));
    await mount();
    const before = mocks.apiFetch.mock.calls.filter(([path]) => path === UNIFIED_ATTENTION_PATH).length;
    await fire(eventName);
    const after = mocks.apiFetch.mock.calls.filter(([path]) => path === UNIFIED_ATTENTION_PATH).length;
    expect(after).toBe(before + 1);
  });

  it('withdraws the previous claim while re-reading and offers the old rows only as stale', async () => {
    route(() => Promise.resolve(Response.json(readBody())));
    await mount();
    const first = latest.result;
    expect(first.kind).toBe('ok');

    const pending = deferred();
    route(() => pending.promise);
    await fire('cat-cafe:proposal-updated');

    expect(latest.result).toEqual({ kind: 'loading' });
    expect(latest.staleRead).toEqual(first.kind === 'ok' ? first.read : null);

    await act(async () => pending.resolve(new Response('{}', { status: 500 })));
    expect(latest.result).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(latest.staleRead).toBeNull();
  });

  describe('previous rows are only ever shown to the person who read them', () => {
    it('hides them while this round’s session is not yet confirmed, then shows them for the same owner', async () => {
      route(() => Promise.resolve(Response.json(readBody())));
      await mount();
      expect(latest.result.kind).toBe('ok');

      const sessionPending = deferred();
      route(
        () => deferred().promise,
        () => sessionPending.promise,
      );
      await fire('cat-cafe:proposal-updated');
      expect(latest.result).toEqual({ kind: 'loading' });
      expect(latest.staleRead).toBeNull();

      await act(async () => sessionPending.resolve(Response.json({ userId: 'owner-1' })));
      expect(latest.staleRead?.identity.ownerUserId).toBe('owner-1');
    });

    it('never shows them when the session has become a different user, even before the new read arrives', async () => {
      route(() => Promise.resolve(Response.json(readBody())));
      await mount();
      expect(latest.result.kind).toBe('ok');

      route(
        () => deferred().promise,
        () => Promise.resolve(Response.json({ userId: 'owner-2' })),
      );
      await fire('cat-cafe:proposal-updated');
      expect(latest.result).toEqual({ kind: 'loading' });
      expect(latest.staleRead).toBeNull();
    });

    it('never shows them when the session cannot be confirmed at all', async () => {
      route(() => Promise.resolve(Response.json(readBody())));
      await mount();

      route(
        () => deferred().promise,
        () => Promise.resolve(new Response('{}', { status: 500 })),
      );
      await fire('cat-cafe:proposal-updated');
      expect(latest.staleRead).toBeNull();
    });
  });

  it('ignores an older response that arrives after a newer one', async () => {
    const older = deferred();
    const newer = deferred();
    const queue = [older, newer];
    route(() => (queue.shift() as Deferred).promise);
    await mount();
    await fire('cat-cafe:proposal-updated');

    await act(async () => newer.resolve(Response.json(readBody({ totalCount: 7, items: [] }))));
    expect(latest.result.kind === 'ok' && latest.result.read.totalCount).toBe(7);

    await act(async () => older.resolve(Response.json(readBody({ totalCount: 2, items: [] }))));
    expect(latest.result.kind === 'ok' && latest.result.read.totalCount).toBe(7);
  });

  describe('read generations (F322 S3-2b-1c: "after" is a count of this panel\'s own reads, not a clock)', () => {
    it('counts the reads it has started: the mount read is the first, and the answer carries the generation it was asked in', async () => {
      const pending = deferred();
      route(() => pending.promise);
      await mount();
      expect(latest.readsStarted()).toBe(1);
      expect(latest.resultGeneration).toBeNull();

      await act(async () => pending.resolve(Response.json(readBody())));
      expect(latest.readsStarted()).toBe(1);
      expect(latest.resultGeneration).toBe(1);
    });

    it('every re-read is a new generation, and its answer is stamped with that one', async () => {
      route(() => Promise.resolve(Response.json(readBody())));
      await mount();
      await fire('cat-cafe:proposal-updated');
      expect(latest.readsStarted()).toBe(2);
      expect(latest.resultGeneration).toBe(2);
      await act(async () => latest.refetch());
      expect(latest.readsStarted()).toBe(3);
      expect(latest.resultGeneration).toBe(3);
    });

    it('a read in flight has no generation of its own result yet, but the count has already moved', async () => {
      const second = deferred();
      const queue: Array<Promise<Response>> = [Promise.resolve(Response.json(readBody())), second.promise];
      route(() => queue.shift() as Promise<Response>);
      await mount();
      act(() => latest.refetch());
      // Synchronous: a write that ends right now must see that a newer read has already begun.
      expect(latest.readsStarted()).toBe(2);
      expect(latest.result).toEqual({ kind: 'loading' });
      expect(latest.resultGeneration).toBeNull();
      await act(async () => second.resolve(Response.json(readBody())));
      expect(latest.resultGeneration).toBe(2);
    });

    it('an older answer that arrives late neither replaces the newer one nor its generation', async () => {
      const older = deferred();
      const newer = deferred();
      const queue = [older, newer];
      route(() => (queue.shift() as Deferred).promise);
      await mount();
      await fire('cat-cafe:proposal-updated');
      await act(async () => newer.resolve(Response.json(readBody({ totalCount: 7, items: [] }))));
      expect(latest.resultGeneration).toBe(2);
      await act(async () => older.resolve(Response.json(readBody({ totalCount: 2, items: [] }))));
      expect(latest.resultGeneration).toBe(2);
      expect(latest.readsStarted()).toBe(2);
    });

    it('a failed read has a generation too: it is a read that was made and could not be used', async () => {
      route(() => Promise.resolve(new Response('{}', { status: 500 })));
      await mount();
      expect(latest.result).toEqual({ kind: 'failed', reason: 'unavailable' });
      expect(latest.resultGeneration).toBe(1);
    });

    it('readsStarted is one stable function, so a host that captured it still sees the live count', async () => {
      route(() => Promise.resolve(Response.json(readBody())));
      await mount();
      const first = latest.readsStarted;
      await fire('cat-cafe:proposal-updated');
      expect(latest.readsStarted).toBe(first);
      expect(first()).toBe(2);
    });
  });

  it('aborts the in-flight read on unmount', async () => {
    const pending = deferred();
    let signal: AbortSignal | undefined;
    mocks.apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/session') return Promise.resolve(Response.json({ userId: 'owner-1' }));
      signal = init?.signal ?? undefined;
      return pending.promise;
    });
    await mount();
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    root = createRoot(container);
  });
});
