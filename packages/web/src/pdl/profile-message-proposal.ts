import type { ProfileUpdateProposalStatus, RichCardBlock } from '@cat-cafe/shared';
import { readOriginalApprovalSource } from '@/components/rich/read-domain-approval-source';
import { lookupSettled } from '@/components/shell/mailbox/settled-lookup';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import type { ProposalTarget } from './proposal-models';

/** An authenticated card projection, not the private server-side ProfileUpdateProposal. */
export interface ProfileMessageProposal {
  proposalId: string;
  status: ProfileUpdateProposalStatus;
  createdBy: string;
  sourceThreadId: string;
  cardMessageId: string;
  card: RichCardBlock;
  sourceCatId?: string;
  detail?: Record<string, unknown>;
}

export function profileMessageFromBody(target: ProposalTarget, raw: unknown): ProfileMessageProposal {
  const p = raw as ProfileMessageProposal | null;
  if (
    !p ||
    p.proposalId !== target.id ||
    p.createdBy !== apiSessionIdentity.getSnapshot().ownerUserId ||
    p.sourceThreadId !== target.threadId ||
    p.cardMessageId !== target.mid ||
    !target.block ||
    JSON.stringify(p.card) !== JSON.stringify(target.block)
  )
    throw new Error('提议来源不可用');
  return p;
}

export async function readProfileMessageProposal(target: ProposalTarget, raw: unknown, fresh: boolean) {
  const owner = apiSessionIdentity.getSnapshot();
  const body = raw as { proposalId?: unknown; status?: unknown } | null;
  if (
    !owner.ownerUserId ||
    !target.block ||
    body?.proposalId !== target.id ||
    typeof body.status !== 'string' ||
    !['pending', 'approving', 'approved', 'rejected'].includes(body.status)
  )
    throw new Error('提议来源不可用');
  const coordinate = { threadId: target.threadId, messageId: target.mid };
  const source = await readOriginalApprovalSource(
    target.block,
    coordinate,
    { feature: 'F231', proposalId: target.id },
    fresh,
  );
  if (owner !== apiSessionIdentity.getSnapshot()) throw new Error('提议来源已变化');
  if (source) {
    if (source.ownerUserId !== owner.ownerUserId || (body.status === 'pending' && source.item.resolution !== 'open'))
      throw new Error('提议来源已变化');
  } else {
    // A missing pending row is never a decision. Terminal status needs the owner's canonical anchored history.
    if (body.status !== 'approved' && body.status !== 'rejected') throw new Error('提议来源不可用');
    const result = await lookupSettled({
      ownerUserId: owner.ownerUserId,
      sourceFeatureId: 'F231',
      proposalId: target.id,
      approvalCardRef: coordinate,
    });
    if (
      owner !== apiSessionIdentity.getSnapshot() ||
      result.kind !== 'found' ||
      result.terminal.resolution !== (body.status === 'approved' ? 'accepted' : 'rejected')
    )
      throw new Error('提议结果尚未确认');
  }
  return profileMessageFromBody(target, {
    proposalId: target.id,
    status: body.status,
    createdBy: owner.ownerUserId,
    sourceThreadId: coordinate.threadId,
    cardMessageId: coordinate.messageId,
    card: target.block,
    ...(source ? { sourceCatId: source.item.requesterCatId, detail: source.item.detail } : {}),
  });
}
