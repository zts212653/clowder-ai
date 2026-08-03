import {
  type ApprovalOriginRef,
  createCatId,
  type DispatchProposal,
  type EntityProposal,
  type TasteProposal,
} from '@cat-cafe/shared';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { IDispatchProposalStore } from '../domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import type { IEntityProposalStore } from '../domains/approval-hub/stores/ports/IEntityProposalStore.js';
import type { ITasteProposalStore } from '../domains/taste/stores/ports/TasteProposalStore.js';
import { buildDispatchProposalCardBlock } from './dispatch-proposal-card-block.js';
import { buildEntityProposalCardBlock } from './entity-proposal-card-block.js';
import { buildTasteProposalCardBlock } from './taste-proposal-card-block.js';

export function publishDispatchProposal(
  ingress: ApprovalIngress,
  store: IDispatchProposalStore,
  proposal: DispatchProposal,
  originRef: ApprovalOriginRef,
) {
  return ingress.publish(
    {
      producerId: 'F193',
      canonicalProposalId: proposal.proposalId,
      ownerUserId: proposal.ownerUserId,
      requesterCatId: createCatId(proposal.senderCatId),
      originRef,
      cardThreadId: proposal.sourceThreadId,
      cardContent: `提议跨 thread 派工：${proposal.content.slice(0, 80)}${proposal.content.length > 80 ? '…' : ''}`,
      cardBlock: buildDispatchProposalCardBlock(proposal),
      createdAt: proposal.createdAt,
    },
    store,
  );
}

export function publishEntityProposal(
  ingress: ApprovalIngress,
  store: IEntityProposalStore,
  proposal: EntityProposal,
  originRef: ApprovalOriginRef,
) {
  return ingress.publish(
    {
      producerId: 'F260',
      canonicalProposalId: proposal.proposalId,
      ownerUserId: proposal.ownerUserId,
      requesterCatId: createCatId(proposal.sourceCatId),
      originRef,
      cardThreadId: proposal.sourceThreadId,
      cardContent: `提议注册实体：${proposal.canonicalName}`,
      cardBlock: buildEntityProposalCardBlock(proposal),
      createdAt: proposal.createdAt,
    },
    store,
  );
}

export function publishTasteProposal(
  ingress: ApprovalIngress,
  store: ITasteProposalStore,
  proposal: TasteProposal,
  originRef: ApprovalOriginRef,
) {
  return ingress.publish(
    {
      producerId: 'F221',
      canonicalProposalId: proposal.id,
      ownerUserId: proposal.userId,
      requesterCatId: createCatId(proposal.catId),
      originRef,
      cardThreadId: proposal.threadId,
      cardContent: `提议捕捉品味信号：${proposal.scene.slice(0, 60)}${proposal.scene.length > 60 ? '…' : ''}`,
      cardBlock: buildTasteProposalCardBlock(proposal),
      createdAt: proposal.createdAt,
    },
    store,
  );
}
