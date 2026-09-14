import type { ApprovalHubItem } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const mockApiFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import { isApprovalItemBatchDecidable } from '@/lib/approval-features';
import { useApprovalHubStore } from '../approvalHubStore';

const ITEM: ApprovalHubItem = {
  proposalId: 'HGP-1',
  sourceFeatureId: 'F257',
  requesterCatId: 'system',
  ownerUserId: 'owner-1',
  resolution: 'open',
  materialization: { state: 'not_started' },
  summary: 'Harness 治理：演进 D1',
  detail: {},
  navigation: anchoredApprovalNavigation('thread_eval_f257_obj'),
  inlineApprovable: true,
  decisionMode: 'approve-skip-reject',
  createdAt: 1,
};

describe('F257 Approval Hub decisions', () => {
  beforeEach(() => {
    mockApiFetch.mockClear();
    useApprovalHubStore.setState({
      items: [ITEM],
      count: 1,
      selectedIds: new Set(),
      batchResults: [],
      deciding: {},
      error: null,
    });
  });

  it.each([
    ['approve', 'ship it'],
    ['skip', 'more data'],
    ['reject', 'draft is wrong'],
  ] as const)('posts the %s decision and note to the F257-owned route', async (action, note) => {
    expect(await useApprovalHubStore.getState().decideHarnessGovernance(ITEM.proposalId, action, note)).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/harness-governance-candidates/${ITEM.proposalId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    expect(useApprovalHubStore.getState().items).toHaveLength(0);
  });

  it('requires a reject reason before issuing any write', async () => {
    expect(await useApprovalHubStore.getState().decideHarnessGovernance(ITEM.proposalId, 'reject', '  ')).toBe(false);
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(useApprovalHubStore.getState().items).toHaveLength(1);
    expect(useApprovalHubStore.getState().error).toContain('必须填写理由');
  });

  it('keeps three-way governance out of approve/reject batches', () => {
    expect(isApprovalItemBatchDecidable(ITEM)).toBe(false);
    useApprovalHubStore.getState().selectAllInline();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(0);
  });
});
