import type { ApprovalHubItem } from '@cat-cafe/shared';
import { vi } from 'vitest';
import { approvalRow, okRead, storeItem } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { apiFetch } from '@/utils/api-client';

export const revision = `sha256:${'a'.repeat(64)}`;
export const proposal = {
  proposalId: 'correction-a',
  status: 'pending',
  expectedRevision: revision,
  reason: 'outdated',
  suggestedPatch: { summary: '后来核实的解释。', cognitiveTransition: 'scope_correction' },
  sourceCatId: 'codex61-sol',
  sourceThreadId: 'thread-a',
  source: { threadId: 'evidence-thread', messageId: 'evidence-message' },
  createdAt: 100,
};
export const event = {
  eventId: 'event-a',
  ownerUserId: 'owner-1',
  type: '数学之美',
  trigger: 'human_brake',
  cat: 'codex61-sol',
  threadId: 'evidence-thread',
  messageId: 'evidence-message',
  timestamp: 90,
  summary: '原来的解释。',
  cognitiveTransition: null,
  relatedHarness: null,
  confidence: 'high',
  revision,
  status: 'active',
  pendingCorrectionCount: 1,
  correctionProposals: [proposal],
};

export function createCorrectionItem(): ApprovalHubItem {
  return storeItem({
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F321',
    requesterCatId: proposal.sourceCatId,
    createdAt: proposal.createdAt,
    summary: 'Event correction: event-a',
    detail: {
      eventId: 'event-a',
      expectedRevision: revision,
      reason: proposal.reason,
      suggestedPatch: proposal.suggestedPatch,
      source: proposal.source,
    },
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-a', messageId: 'origin' },
      approvalCardRef: { threadId: 'thread-a', messageId: 'card-a' },
    },
  });
}

interface SourceState {
  pending: boolean;
  owner: string;
  changed: boolean;
  terminal: boolean;
  approveOnPost: boolean;
  approving?: boolean;
}
export function installCorrectionApi(
  state: () => SourceState,
  currentItem: () => ApprovalHubItem,
  onApprove: () => void,
) {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const { pending, owner, changed, terminal, approveOnPost, approving } = state();
    const item = currentItem();
    const currentProposal = approving ? { ...proposal, status: 'approving' } : proposal;
    if (init?.method === 'POST') {
      if (approveOnPost) {
        onApprove();
      }
      return Response.json({ proposalId: proposal.proposalId, status: 'approved', appliedRevision: revision });
    }
    if (path === '/api/session') return Response.json({ userId: 'owner-1' });
    if (String(path).includes('/approval-hub/pending'))
      return Response.json({ items: pending ? [item] : [], count: pending ? 1 : 0 });
    if (String(path).includes('/approval-hub/settled'))
      return Response.json({
        items: terminal
          ? [{ ...item, resolution: approveOnPost ? 'accepted' : 'rejected', decidedAt: 200, decidedBy: 'owner-1' }]
          : [],
      });
    if (String(path).includes('/concierge/')) {
      const read = okRead(pending ? [approvalRow(item)] : []);
      return Response.json(read.kind === 'ok' ? read.read : null);
    }
    if (String(path).includes('/api/event-memory-corrections/'))
      return Response.json({
        proposal: terminal
          ? {
              ...proposal,
              status: approveOnPost ? 'approved' : 'rejected',
              ...(approveOnPost ? { appliedRevision: revision } : {}),
            }
          : currentProposal,
      });
    if (String(path).includes('/api/memory/events/'))
      return Response.json({
        ...event,
        ownerUserId: owner,
        revision: changed ? `sha256:${'b'.repeat(64)}` : revision,
        correctionProposals: [currentProposal],
      });
    return Response.json({});
  });
}
