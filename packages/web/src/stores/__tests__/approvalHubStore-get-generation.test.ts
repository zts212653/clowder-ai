import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('approval owner refresh through the real API GET coordinator', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('location', { hostname: 'localhost', port: '3001', protocol: 'http:' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['pending', 'settled'] as const)('reads a fresh %s generation after an overlapping refresh', async (lane) => {
    const prior = deferred<Response>();
    let physicalReads = 0;
    const item = { proposalId: 'approval-owned-before-refresh', status: lane === 'pending' ? 'pending' : 'approved' };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).includes('/api/session')) return Promise.resolve(new Response('{}'));
        expect(String(url)).toContain('/api/approval-hub/' + lane);
        physicalReads += 1;
        return physicalReads === 1
          ? prior.promise
          : Promise.resolve(new Response(JSON.stringify({ items: [item], count: 1 })));
      }),
    );
    const { useApprovalHubStore } = await import('../approvalHubStore');
    const read = () =>
      lane === 'pending'
        ? useApprovalHubStore.getState().fetchPending()
        : useApprovalHubStore.getState().fetchSettled();
    const old = read();
    await vi.waitFor(() => expect(physicalReads).toBe(1));
    const changed = read();
    const concurrent = read();
    prior.resolve(new Response(JSON.stringify({ items: [], count: 0 })));
    await Promise.all([old, changed, concurrent]);
    expect(physicalReads).toBe(2);
    const state = useApprovalHubStore.getState();
    expect(lane === 'pending' ? state.items : state.settledItems).toEqual([item]);
    expect(lane === 'pending' ? state.error : state.settledError).toBeNull();
  });

  it('recovers a current pending refresh after the earlier physical GET fails', async () => {
    const prior = deferred<Response>();
    let physicalReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).includes('/api/session')) return Promise.resolve(new Response('{}'));
        physicalReads += 1;
        return physicalReads === 1
          ? prior.promise
          : Promise.resolve(new Response(JSON.stringify({ items: [{ proposalId: 'fresh' }], count: 1 })));
      }),
    );
    const { useApprovalHubStore } = await import('../approvalHubStore');
    const old = useApprovalHubStore.getState().fetchPending();
    await vi.waitFor(() => expect(physicalReads).toBe(1));
    const current = useApprovalHubStore.getState().fetchPending();
    prior.reject(new Error('earlier network failure'));
    await Promise.all([old, current]);
    expect(physicalReads).toBe(2);
    expect(useApprovalHubStore.getState().items).toEqual([{ proposalId: 'fresh' }]);
    expect(useApprovalHubStore.getState().error).toBeNull();
  });
});
