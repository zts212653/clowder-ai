/**
 * F260 Phase I: entity proposal approval card block.
 *
 * Shown in the source thread when a cat proposes a new entity registration.
 * Informational only — no `actions` array.  Decisions happen in the F246
 * Approval Hub panel (the canonical decision surface).  This is a permanent
 * boundary: approval cards are status indicators, not interactive controls.
 */

import type { EntityProposal, RichCardBlock } from '@cat-cafe/shared';

export function buildEntityProposalCardBlock(proposal: EntityProposal): RichCardBlock {
  return {
    id: `entity-proposal-${proposal.proposalId}`,
    kind: 'card',
    v: 1,
    title: `提议注册实体：${proposal.canonicalName}`,
    bodyMarkdown: proposal.rationale,
    tone: 'info',
    fields: [
      { label: '实体 ID', value: proposal.entityId },
      { label: '类型', value: proposal.entityType },
      { label: '别名', value: proposal.aliases.join(', ') },
      { label: '立场', value: proposal.stance },
      { label: '提议猫', value: proposal.sourceCatId },
    ],
  };
}
