import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { readConfirmedApprovalTerminal } from '../approval-confirmation-read';
import { storeItem } from './mailbox-fixtures';

const ask = { ownerUserId: 'owner-1', sourceFeatureId: 'F193', proposalId: 'p-1' };
const row = { ...ask, resolution: 'rejected', decidedAt: 42, decidedBy: 'owner-1' };

function responses(
  options: {
    pending?: unknown;
    history?: unknown;
    session?: unknown;
    pendingStatus?: number;
    historyStatus?: number;
    sessionStatus?: number;
  } = {},
) {
  mocks.apiFetch.mockImplementation((path: string) => {
    if (path === '/api/session')
      return Promise.resolve(
        Response.json(options.session ?? { userId: ask.ownerUserId }, { status: options.sessionStatus ?? 200 }),
      );
    if (path === '/api/approval-hub/pending')
      return Promise.resolve(
        Response.json(options.pending ?? { items: [], coverage: { state: 'complete' } }, {
          status: options.pendingStatus ?? 200,
        }),
      );
    if (path.startsWith('/api/approval-hub/settled'))
      return Promise.resolve(
        Response.json(options.history ?? { items: [row] }, { status: options.historyStatus ?? 200 }),
      );
    throw new Error(`Unexpected request ${path}`);
  });
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
});

describe('approval-only confirmation', () => {
  it('uses canonical pending/history and a final session check, all from post-write GET generations', async () => {
    responses();
    await expect(readConfirmedApprovalTerminal(ask)).resolves.toEqual({
      resolution: 'rejected',
      decidedAt: 42,
      decidedBy: ask.ownerUserId,
    });
    const paths = mocks.apiFetch.mock.calls.map(([path]) => path);
    expect(paths).toEqual(['/api/approval-hub/pending', '/api/approval-hub/settled?limit=200', '/api/session']);
    for (const [, , options] of mocks.apiFetch.mock.calls) expect(options).toEqual({ afterCurrentGet: true });
  });

  it.each([
    [
      'still pending / partial approval',
      { pending: { items: [storeItem({ sourceFeatureId: 'F193' })], coverage: { state: 'complete' } } },
    ],
    ['pending coverage unknown', { pending: { items: [] } }],
    ['pending coverage partial', { pending: { items: [], coverage: { state: 'partial' } } }],
    ['malformed pending data', { pending: { items: [{}], coverage: { state: 'complete' } } }],
    [
      'foreign pending owner',
      {
        pending: {
          items: [storeItem({ proposalId: 'other', ownerUserId: 'foreign' })],
          coverage: { state: 'complete' },
        },
      },
    ],
    ['absent without a terminal', { history: { items: [] } }],
    ['wrong terminal owner', { history: { items: [{ ...row, ownerUserId: 'foreign' }] } }],
    ['wrong terminal producer', { history: { items: [{ ...row, sourceFeatureId: 'F128' }] } }],
    ['wrong terminal proposal', { history: { items: [{ ...row, proposalId: 'other' }] } }],
    ['unknown terminal', { history: { items: [{ ...row, resolution: 'open' }] } }],
    ['pending failed', { pendingStatus: 503 }],
    ['history failed', { historyStatus: 503 }],
    ['session failed', { sessionStatus: 401 }],
    ['owner changed', { session: { userId: 'foreign' } }],
    ['unreadable owner', { session: {} }],
  ])('leaves ordinary reconciliation in charge when %s', async (_name, options) => {
    responses(options);
    await expect(readConfirmedApprovalTerminal(ask)).resolves.toBeNull();
  });

  it('does not publish after cancellation while its final principal read is outstanding', async () => {
    responses();
    let release!: (response: Response) => void;
    const usual = mocks.apiFetch.getMockImplementation();
    if (!usual) throw new Error('Missing response fixture');
    mocks.apiFetch.mockImplementation((...args) =>
      args[0] === '/api/session'
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : usual(...args),
    );
    const controller = new AbortController();
    const read = readConfirmedApprovalTerminal({ ...ask, signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    release(Response.json({ userId: ask.ownerUserId }));
    await expect(read).resolves.toBeNull();
  });

  it('contains network errors without treating them as decisions', async () => {
    mocks.apiFetch.mockRejectedValue(new TypeError('network failed'));
    await expect(readConfirmedApprovalTerminal(ask)).resolves.toBeNull();
  });
});
