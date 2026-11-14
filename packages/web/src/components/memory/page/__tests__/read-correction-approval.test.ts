import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectiveFailure } from '@/components/shell/mailbox/__tests__/collective-failure.fixture';
import { approvalRow, OWNER, okRead, storeItem } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { apiFetch } from '@/utils/api-client';
import { readPublishedCorrection } from '../read-correction-approval';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const coordinate = { threadId: 'thread-correction-1', messageId: 'msg-correction-1' };
const block: RichCardBlock = {
  v: 1,
  kind: 'card',
  id: 'event-memory-correction-corr-1',
  title: '事件修正建议',
  meta: { approval: { producerId: 'F321', canonicalProposalId: 'corr-1' } },
};

function correctionItem(): ApprovalHubItem {
  return storeItem({
    proposalId: 'corr-1',
    sourceFeatureId: 'F321',
    summary: '修正事件摘要',
    inlineApprovable: true,
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: coordinate.threadId, messageId: 'origin-1' },
      approvalCardRef: { threadId: coordinate.threadId, messageId: coordinate.messageId },
    },
  });
}

describe('readPublishedCorrection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps F321 Chat correction cards readable during Collective outages while failing closed on approvals or conflict faults', async () => {
    const item = correctionItem();
    const outage = collectiveFailure(okRead([approvalRow(item)]), true);
    if (outage.kind !== 'ok') throw new Error('Expected ok read');
    outage.read.sources.collectiveProjectAttention = {
      status: 'available',
      coverage: 'pending_f290_project_materials_and_dates',
      exhaustiveness: 'partial',
      startedAt: 1,
      observedAt: 2,
    };
    outage.read.consistency.reasons.push('collective_project_attention_source_unavailable');

    const mockRead = (readBody: unknown) => {
      vi.mocked(apiFetch).mockImplementation(async (path) => {
        const url = String(path);
        const payload =
          url === '/api/session'
            ? { userId: OWNER }
            : url.includes('/approval-hub/pending')
              ? { items: [item], count: 1 }
              : readBody;
        return { ok: true, status: 200, json: async () => payload } as Response;
      });
    };

    mockRead(outage.read);
    expect((await readPublishedCorrection(block, coordinate))?.proposalId).toBe('corr-1');

    const approvalsPartial = structuredClone(outage.read);
    approvalsPartial.sources.approvals.exhaustiveness = 'partial';
    mockRead(approvalsPartial);
    expect(await readPublishedCorrection(block, coordinate)).toBeNull();

    const conflictOutage = structuredClone(outage.read);
    conflictOutage.consistency.reasons.push('collective_accountability_identity_conflict');
    mockRead(conflictOutage);
    expect(await readPublishedCorrection(block, coordinate)).toBeNull();
  });
});
