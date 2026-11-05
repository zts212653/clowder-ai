import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { readPersonMemorySnapshot } from '../person-memory-proposal-source';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const snapshot = {
  proposalId: 'person_candidate_original',
  status: 'materialized',
  publicationState: 'anchored',
  approvalCardMessageId: 'original-card',
  remainingDraftIds: [],
  decisionReceipt: {
    decisionId: 'exact-decision',
    materializedClaimIds: ['claim-original'],
    materializedRelationshipIds: [],
    materializedEventIds: [],
  },
};
beforeEach(() => vi.mocked(apiFetch).mockReset());
it('reads the exact durable decision through the original owner endpoint', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json(snapshot));
  expect(await readPersonMemorySnapshot(snapshot.proposalId, 'original-card')).toEqual(snapshot);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/person-memory-proposals/person_candidate_original',
    {},
    { afterCurrentGet: true },
  );
});
it.each([
  { ...snapshot, approvalCardMessageId: 'foreign-card' },
  { ...snapshot, proposalId: 'other-candidate' },
  { ...snapshot, publicationState: 'staged' },
  { ...snapshot, decisionReceipt: { decisionId: 'invented' } },
])('rejects a different or incomplete anchored receipt', async (value) => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json(value));
  expect(await readPersonMemorySnapshot(snapshot.proposalId, 'original-card')).toBeNull();
});
