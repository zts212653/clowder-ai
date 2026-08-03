import type { ApprovalItem } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { useApprovalHubStore } from '../approvalHubStore';

const ITEM: ApprovalItem = {
  proposalId: 'person_candidate_1',
  sourceFeatureId: 'F276',
  navigation: anchoredApprovalNavigation('thread_people'),
  requesterCatId: 'codex-sol',
  ownerUserId: 'owner-1',
  status: 'pending',
  summary: '记住人物：黄挺',
  detail: {
    displayName: '黄挺',
    drafts: [
      {
        draftId: 'person_draft_fact',
        claimKind: 'reported_fact',
        normalizedDraft: '黄挺属于终端用户计算开发部',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: '黄挺是终端用户计算开发部 21 级',
      },
    ],
    remainingDraftIds: ['person_draft_fact'],
  },
  inlineApprovable: true,
  decisionMode: 'claim-select',
  createdAt: 100,
};

describe('approvalHubStore F276 claim-select decisions', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ proposalId: ITEM.proposalId, status: 'materialized' }),
    });
    useApprovalHubStore.setState({
      items: [ITEM],
      count: 1,
      deciding: {},
      selectedIds: new Set<string>(),
      batchResults: [],
      error: null,
    });
  });

  it('posts exact selected draft IDs with a stable decision ID', async () => {
    await useApprovalHubStore.getState().approvePersonMemory(ITEM.proposalId, ['person_draft_fact']);
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/person-memory-proposals/${ITEM.proposalId}/approve`,
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"selectedDraftIds":["person_draft_fact"]'),
      }),
    );
    const payload = JSON.parse(mockApiFetch.mock.calls[0][1].body);
    expect(payload.decisionId).toMatch(/^f276_/);
  });

  it('never admits claim-select items into generic batch approval', () => {
    useApprovalHubStore.getState().selectAllInline();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(0);
  });

  it('posts not-now through the feature-owned endpoint', async () => {
    await useApprovalHubStore.getState().notNowPersonMemory(ITEM.proposalId);
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/person-memory-proposals/${ITEM.proposalId}/not-now`,
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"decisionId"') }),
    );
  });

  it('posts reject feedback with a stable decision ID and returns success', async () => {
    const success = await useApprovalHubStore
      .getState()
      .rejectProposal(ITEM.proposalId, { reasonCode: 'bad_evidence' });

    expect(success).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/person-memory-proposals/${ITEM.proposalId}/reject`,
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"feedback":{"reasonCode":"bad_evidence"}'),
      }),
    );
    const payload = JSON.parse(mockApiFetch.mock.calls[0][1].body);
    expect(payload.decisionId).toMatch(/^f276_reject_/);
  });

  it('returns false and keeps the card on a reject conflict', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'proposal_conflict', message: '提案状态已变化' }),
    });

    const success = await useApprovalHubStore.getState().rejectProposal(ITEM.proposalId, { reasonCode: 'wrong' });

    expect(success).toBe(false);
    expect(useApprovalHubStore.getState().items).toEqual([ITEM]);
    expect(useApprovalHubStore.getState().error).toBe('提案状态已变化');
    expect(useApprovalHubStore.getState().deciding[ITEM.proposalId]).toBeUndefined();
  });

  it('withdraws a pending card without treating the correction as an entity rejection', async () => {
    await useApprovalHubStore.getState().withdrawPersonMemory(ITEM.proposalId);
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/person-memory-proposals/${ITEM.proposalId}/withdraw`,
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"decisionId"') }),
    );
    expect(useApprovalHubStore.getState().items).toEqual([]);
  });
});
