import type { EventMemoryCorrectionProposal, RichCardBlock } from '@cat-cafe/shared';

const REASON_LABELS: Record<EventMemoryCorrectionProposal['reason'], string> = {
  unsupported_by_source: '原文不支持这个概括',
  outdated: '这条概括已经过时',
  not_applicable_here: '这次不适用',
};

export function buildEventMemoryCorrectionCardBlock(proposal: EventMemoryCorrectionProposal): RichCardBlock {
  const patch = JSON.stringify(proposal.suggestedPatch, null, 2);
  const preview = patch.length > 800 ? `${patch.slice(0, 797)}…` : patch;
  return {
    id: `event-memory-correction-${proposal.proposalId}`,
    kind: 'card',
    v: 1,
    title: '提议更正一条事件记忆',
    bodyMarkdown: [`**原因：** ${REASON_LABELS[proposal.reason]}`, '', '```json', preview, '```'].join('\n'),
    tone: 'info',
    fields: [
      { label: '事件', value: proposal.eventId },
      { label: '原版本', value: proposal.expectedRevision },
      { label: '提议猫', value: proposal.sourceCatId },
    ],
  };
}
