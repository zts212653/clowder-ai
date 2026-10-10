import type { ApprovalHubItem } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { useApprovalHubStore } from '../approvalHubStore';

const card = { proposalId: 'new-card' } as ApprovalHubItem;
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (value: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe('Approval Hub canonical refresh ordering', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    useApprovalHubStore.setState({ items: [], count: 0, error: null, isLoading: false });
  });
  it.each(['empty', 'error'])('ignores an older %s response after a newer card refresh', async (outcome) => {
    const old = deferred();
    apiFetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ items: [card], count: 1 }));
    const first = useApprovalHubStore.getState().fetchPending();
    await useApprovalHubStore.getState().fetchPending();
    if (outcome === 'empty') old.resolve(Response.json({ items: [], count: 0 }));
    else old.reject(new Error('old network error'));
    await first;
    expect(useApprovalHubStore.getState()).toMatchObject({ items: [card], count: 1, error: null, isLoading: false });
  });
  it('does not resurrect an item removed by a decision while its older GET is in flight', async () => {
    useApprovalHubStore.setState({ items: [card], count: 1 });
    const old = deferred();
    apiFetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ items: [], count: 0 }));
    const pending = useApprovalHubStore.getState().fetchPending();
    useApprovalHubStore.setState({ items: [], count: 0 });
    old.resolve(Response.json({ items: [card], count: 1 }));
    await pending;
    expect(useApprovalHubStore.getState().items).toEqual([]);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
