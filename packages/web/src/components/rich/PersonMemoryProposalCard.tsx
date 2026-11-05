'use client';
import { isPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import type { RichCardBlock } from '@/stores/chat-types';
import { PersonMemoryApprovalCard } from './PersonMemoryApprovalCard';
import type { PersonMemoryCoordinate } from './person-memory-proposal-source';

export function PersonMemoryProposalCard({
  block,
  coordinate,
}: {
  block: RichCardBlock;
  messageId?: string;
  coordinate?: PersonMemoryCoordinate;
}) {
  if (!isPersonMemoryProposalCardBlock(block)) return <p role="status">人物记忆审批卡格式无效</p>;
  return <PersonMemoryApprovalCard proposalId={block.meta.candidateId} block={block} coordinate={coordinate} />;
}
