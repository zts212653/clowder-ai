import type { RichCardBlock } from '@cat-cafe/shared';
import { isPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import { correctionPublicationCandidate } from '@/components/memory/page/read-correction-approval';
import { evalRepairCandidate } from '@/components/rich/eval-repair-model';
import { domainApprovalCandidate } from '@/components/rich/read-domain-approval-source';
import { schedulePublicationCandidate } from '@/components/rich/read-schedule-approval';
import type { ChatMessage } from '@/stores/chat-types';
import type { MemoryMessageTarget } from './memory-message-proposals';
import { type ProposalTarget, proposalTarget } from './proposal-models';

/** A card a message carries. `blockId` is the rich block it came from (none for cards carried in message fields). */
export type MessageCard =
  | { type: 'evidence'; mid: string; blockId: string; block: RichCardBlock }
  | { type: 'work'; mid: string; blockId: string; block: RichCardBlock }
  | { type: 'memory'; mid: string; blockId: string; block: RichCardBlock; target: MemoryMessageTarget }
  | { type: 'proposal'; mid: string; blockId: string; block: RichCardBlock; target: ProposalTarget }
  | { type: 'schedule'; mid: string; blockId: string; block: RichCardBlock }
  | { type: 'frustration'; mid: string; blockId: string; block: RichCardBlock; issueId: string }
  | { type: 'cbauth'; mid: string; blockId: string; block: RichCardBlock }
  | { type: 'custody'; mid: string; revision: NonNullable<ChatMessage['extra']>['custodyOfferV1'] }
  | { type: 'ask'; mid: string; blockId: string; interactionId: string };
export type MessageCardType = MessageCard['type'];

function memoryTarget(block: RichCardBlock, threadId: string, mid: string): MemoryMessageTarget | null {
  if (isPersonMemoryProposalCardBlock(block))
    return { feature: 'F276', id: block.meta.candidateId, threadId, mid, block };
  const correction = correctionPublicationCandidate(block);
  if (correction) return { feature: 'F321', id: correction, threadId, mid, block };
  const repair = evalRepairCandidate(block);
  if (repair) return { feature: 'F266', id: repair, threadId, mid, block };
  const domain = domainApprovalCandidate(block);
  return domain ? { feature: domain.feature, id: domain.proposalId, threadId, mid, block } : null;
}

/**
 * Which cards a message carries — the one place that decides a message card's type. Owner reads, the message's view
 * and exports all ask here; older cards that never stated their type (schedule ids, connector sources, approval
 * actions) are recognised here too, so no reader checks block shapes itself.
 */
export function guessAndRenderCardType(message: ChatMessage, threadId: string): MessageCard[] {
  const mid = message.id,
    extra = message.extra,
    out: MessageCard[] = [];
  (extra?.rich?.blocks ?? []).forEach((block) => {
    if (block.kind !== 'card') return;
    const blockId = block.id,
      meta = block.meta;
    if (meta?.domain === 'message-search-answer') return out.push({ type: 'evidence', mid, blockId, block });
    if (meta?.kind === 'work_reference') return out.push({ type: 'work', mid, blockId, block });
    if (message.source?.connector === 'frustration-auto-issue' && meta?.kind === 'frustration_auto_issue')
      return out.push({ type: 'frustration', mid, blockId, block, issueId: String(meta.issueId) });
    if (message.source?.connector === 'callback-auth' && meta?.kind === 'callback_auth_failure')
      return out.push({ type: 'cbauth', mid, blockId, block });
    if (schedulePublicationCandidate(block)) return out.push({ type: 'schedule', mid, blockId, block });
    const proposal = proposalTarget(block, threadId, mid);
    if (proposal) return out.push({ type: 'proposal', mid, blockId, block, target: proposal });
    const memory = extra?.recall ? null : memoryTarget(block, threadId, mid);
    if (memory) out.push({ type: 'memory', mid, blockId, block, target: memory });
  });
  if (extra?.custodyOfferV1) out.push({ type: 'custody', mid, revision: extra.custodyOfferV1 });
  if (extra?.runtimeInteractionCard)
    out.push({
      type: 'ask',
      mid,
      blockId: extra.runtimeInteractionCard.blockId,
      interactionId: extra.runtimeInteractionCard.interactionId,
    });
  return out;
}

/** The cards of one type across a list of messages. */
export function messageCards<T extends MessageCardType>(
  messages: ChatMessage[],
  threadId: string,
  type: T,
): Extract<MessageCard, { type: T }>[] {
  return messages.flatMap((message) =>
    guessAndRenderCardType(message, threadId).filter(
      (card): card is Extract<MessageCard, { type: T }> => card.type === type,
    ),
  );
}
