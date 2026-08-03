/**
 * F246 Phase H cloud-P2 fix: fetchSettled default limit regression test.
 *
 * Problem: client-side history filters apply to the already-fetched settledItems.
 * If fetchSettled only requests limit=50 but the user has > 50 settled items,
 * filters can produce a false-empty state (e.g. all 50 most-recent are "approved"
 * → clicking "rejected" shows zero results even though rejected items exist in ZSet).
 *
 * Fix: request limit=200 (= server MAX_SETTLED_LIMIT) by default so all realistic
 * Clowder AI operator history is fetched before client-side filtering is applied.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: mockApiFetch,
}));

import { useApprovalHubStore } from '../approvalHubStore';

describe('fetchSettled — default limit (F246-H cloud-P2 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], count: 0 }),
    });
  });

  it('requests limit=200 by default so client-side filters have full history to work with', async () => {
    await useApprovalHubStore.getState().fetchSettled();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const url = mockApiFetch.mock.calls[0][0] as string;
    // Must request MAX_SETTLED_LIMIT (200) so status filters are not falsely empty
    // when the most-recent 50 records happen to all be of the other status.
    expect(url).toContain('limit=200');
  });

  it('passes an explicit limit override through unchanged', async () => {
    await useApprovalHubStore.getState().fetchSettled(10);

    const url = mockApiFetch.mock.calls[0][0] as string;
    expect(url).toContain('limit=10');
  });
});
