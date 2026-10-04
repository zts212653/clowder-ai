import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { lookupSettled, SETTLED_LOOKUP_LIMIT, SETTLED_LOOKUP_PATH } from '../settled-lookup';

/**
 * F322 S3-2b-1c: after a write, an approval that is no longer on the 待办 page is "decided" only if the Approval Hub's settled
 * history has a row for exactly that proposal and producer. The page alone never proves it. This is the exact lookup the
 * reconciler asks for; it must say "found" only for a readable terminal row, and "unavailable" whenever the answer cannot be
 * relied on — including when the history window was full and the row simply may be older than it.
 */
const ask = { ownerUserId: 'owner-1', sourceFeatureId: 'F128', proposalId: 'p-1' };

const row = (overrides: Record<string, unknown> = {}) => ({
  proposalId: 'p-1',
  sourceFeatureId: 'F128',
  ownerUserId: 'owner-1',
  resolution: 'accepted',
  decidedAt: 1_700_000_000_000,
  decidedBy: 'owner-1',
  ...overrides,
});

function answer(body: unknown, status = 200) {
  mocks.apiFetch.mockResolvedValue(Response.json(body, { status }));
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
});

describe('lookupSettled', () => {
  it('asks the settled history for a bounded window, after any write that is still settling', async () => {
    answer({ items: [], count: 0 });
    await lookupSettled(ask);
    expect(SETTLED_LOOKUP_PATH).toBe(`/api/approval-hub/settled?limit=${SETTLED_LOOKUP_LIMIT}`);
    const [path, init, options] = mocks.apiFetch.mock.calls[0];
    expect(path).toBe(SETTLED_LOOKUP_PATH);
    expect(init?.method ?? 'GET').toBe('GET');
    // A GET already in flight when the write ended may predate it: attach to the trailing generation instead.
    expect(options).toEqual({ afterCurrentGet: true });
  });

  it.each([
    'accepted',
    'rejected',
    'closed_without_decision',
  ] as const)('finds a %s row for exactly that proposal', async (resolution) => {
    answer({ items: [row({ proposalId: 'other' }), row({ resolution })], count: 2 });
    await expect(lookupSettled(ask)).resolves.toEqual({
      kind: 'found',
      terminal: { resolution, decidedAt: 1_700_000_000_000, decidedBy: 'owner-1' },
    });
  });

  it('keeps only the facts the row really has', async () => {
    answer({ items: [row({ decidedAt: undefined, decidedBy: '   ' })], count: 1 });
    await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'found', terminal: { resolution: 'accepted' } });
  });

  it('does not take a row of another producer or another proposal for this one', async () => {
    answer({ items: [row({ sourceFeatureId: 'F221' }), row({ proposalId: 'p-2' })], count: 2 });
    await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'not_found' });
  });

  it('does not take another owner’s row for this owner’s', async () => {
    answer({ items: [row({ ownerUserId: 'owner-2' })], count: 1 });
    await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'not_found' });
  });

  it('is not found when a complete history window has no row for it', async () => {
    answer({ items: [row({ proposalId: 'p-9' })], count: 1 });
    await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'not_found' });
  });

  it('cannot say "not found" when the window was full: the row may be older than the window', async () => {
    const full = Array.from({ length: SETTLED_LOOKUP_LIMIT }, (_, index) => row({ proposalId: `other-${index}` }));
    answer({ items: full, count: full.length });
    await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('still finds the row in a full window', async () => {
    const full = Array.from({ length: SETTLED_LOOKUP_LIMIT - 1 }, (_, index) => row({ proposalId: `other-${index}` }));
    answer({ items: [...full, row()], count: SETTLED_LOOKUP_LIMIT });
    await expect(lookupSettled(ask)).resolves.toMatchObject({ kind: 'found' });
  });

  it('prefers the newest row if the history repeats the proposal', async () => {
    answer({
      items: [row({ resolution: 'rejected', decidedAt: 100 }), row({ resolution: 'accepted', decidedAt: 200 })],
      count: 2,
    });
    await expect(lookupSettled(ask)).resolves.toMatchObject({
      kind: 'found',
      terminal: { resolution: 'accepted', decidedAt: 200 },
    });
  });

  it.each([401, 403, 404, 500, 503])('is unavailable when the history answers %i', async (status) => {
    answer({ error: 'no' }, status);
    await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('is unavailable when the request itself fails', async () => {
    mocks.apiFetch.mockRejectedValue(new TypeError('network'));
    await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('is unavailable when it is aborted', async () => {
    const controller = new AbortController();
    mocks.apiFetch.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    controller.abort();
    await expect(lookupSettled({ ...ask, signal: controller.signal })).resolves.toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['a body that is not JSON', 'nope'],
    ['no items', { count: 0 }],
    ['items that are not a list', { items: 'x', count: 1 }],
    ['null', null],
  ])('is unavailable for %s', async (_name, body) => {
    mocks.apiFetch.mockResolvedValue(
      typeof body === 'string' ? new Response(body, { status: 200 }) : Response.json(body, { status: 200 }),
    );
    await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('is unavailable when the matching row does not say a terminal resolution (a row we cannot read is not "decided")', async () => {
    for (const resolution of ['open', 'pending', 7, undefined]) {
      answer({ items: [row({ resolution })], count: 1 });
      await expect(lookupSettled(ask)).resolves.toEqual({ kind: 'unavailable' });
    }
  });

  it('ignores junk entries in the list instead of failing the whole lookup', async () => {
    answer({ items: [null, 'x', 3, [], row()], count: 5 });
    await expect(lookupSettled(ask)).resolves.toMatchObject({ kind: 'found' });
  });
});
