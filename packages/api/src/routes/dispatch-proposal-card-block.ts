/**
 * F193 Phase I: dispatch proposal approval card block.
 *
 * Shown in the source thread when a cat requests assign_work cross-thread dispatch.
 * The publication has no actions. Chat/Inbox can host the original domain
 * writer only after a fresh canonical read verifies this exact publication.
 */

import type { DispatchProposal, RichCardBlock } from '@cat-cafe/shared';

type DispatchCardInput = Pick<
  DispatchProposal,
  'proposalId' | 'content' | 'targetThreadId' | 'targetCats' | 'senderCatId'
> & {
  proposedAction?: Pick<
    NonNullable<DispatchProposal['proposedAction']>,
    'actionFamily' | 'successorSlot' | 'mode' | 'subjectRef'
  > & {
    terminalPredicate?: Pick<NonNullable<NonNullable<DispatchProposal['proposedAction']>['terminalPredicate']>, 'kind'>;
  };
};

export function buildDispatchProposalCardBlock(proposal: DispatchCardInput): RichCardBlock {
  const contentPreview = proposal.content.length > 200 ? `${proposal.content.slice(0, 197)}…` : proposal.content;
  const action = proposal.proposedAction;

  return {
    id: `dispatch-${proposal.proposalId}`,
    kind: 'card',
    v: 1,
    title: '提议跨 thread 派工（assign_work）',
    bodyMarkdown: contentPreview,
    tone: 'info',
    fields: [
      { label: '目标 thread', value: proposal.targetThreadId },
      { label: '目标猫', value: proposal.targetCats.join(', ') || '（无指定）' },
      { label: '发起猫', value: proposal.senderCatId },
      ...(action
        ? [
            { label: 'Action', value: `${action.actionFamily}/${action.successorSlot} (${action.mode})` },
            { label: 'Subject', value: action.subjectRef },
            { label: '完成判据', value: action.terminalPredicate?.kind ?? '（无）' },
          ]
        : []),
    ],
  };
}
