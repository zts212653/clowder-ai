'use client';

import type { RichCardBlock } from '@/stores/chat-types';
import { useShellPresentation } from '../shell/shell-presentation';
import { ProposalCardChat } from './ProposalCardChat';
import { ProposalCardProducer } from './ProposalCardProducer';
import type { ProposalCardInput } from './useProposalCardState';

/** One producer card and one set of writes, with the host choosing its placement. */
export function ProposalCard(props: ProposalCardInput) {
  const shell = useShellPresentation();
  return props.block && shell === 'v2' ? (
    <ProposalCardChat block={props.block} messageId={props.messageId} coordinate={props.coordinate} />
  ) : (
    <ProposalCardProducer {...props} />
  );
}

export function isProposalCardBlock(block: RichCardBlock): boolean {
  return block.actions?.some((a) => a.action === 'propose:approve') ?? false;
}
