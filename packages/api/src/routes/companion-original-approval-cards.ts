import type { ApprovalHubItem, RichBlock, RichCardBlock, UnifiedAttentionOriginalApprovalCard } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isExactInformationalApprovalCard } from './companion-informational-approval-card.js';

type OriginalCardProducerId = 'F225' | 'F231' | 'F193' | 'F221' | 'F260';

type OriginalCardValidator = { blockId(proposalId: string): string } & (
  | { family: 'interactive'; actions: readonly [string, string] }
  | { family: 'informational' }
);

const ORIGINAL_CARD_VALIDATORS = {
  F225: {
    family: 'interactive',
    blockId: (proposalId) => `handoff-${proposalId}`,
    actions: ['handoff:approve', 'handoff:reject'],
  },
  F231: {
    family: 'interactive',
    blockId: (proposalId) => `profile-update-${proposalId}`,
    actions: ['profile-update:approve', 'profile-update:reject'],
  },
  F193: { family: 'informational', blockId: (proposalId) => `dispatch-${proposalId}` },
  F221: { family: 'informational', blockId: (proposalId) => `taste-proposal-${proposalId}` },
  F260: { family: 'informational', blockId: (proposalId) => `entity-proposal-${proposalId}` },
} as const satisfies Record<OriginalCardProducerId, OriginalCardValidator>;

export interface OriginalApprovalCardRead {
  proofs: ReadonlyMap<string, UnifiedAttentionOriginalApprovalCard>;
  reasons: readonly string[];
}

export type OriginalApprovalCardMessageStore = Pick<IMessageStore, 'getById'>;

export function originalApprovalCardKey(item: Pick<ApprovalHubItem, 'sourceFeatureId' | 'proposalId'>): string {
  return `${item.sourceFeatureId}:${item.proposalId}`;
}

/**
 * Re-read producer cards from canonical message storage. A navigation coordinate by
 * itself never grants a hosted writer: the live row, its one ingress stamp and the
 * producer-owned action payload must all still agree.
 */
export async function readOriginalApprovalCards(
  items: ApprovalHubItem[],
  ownerUserId: string,
  messageStore?: OriginalApprovalCardMessageStore,
): Promise<OriginalApprovalCardRead> {
  const candidates = items.filter(isOriginalCardProducer);
  if (candidates.length === 0) return { proofs: new Map(), reasons: [] };
  if (!messageStore) {
    return { proofs: new Map(), reasons: ['original_approval_card_unverified'] };
  }

  const proofs = new Map<string, UnifiedAttentionOriginalApprovalCard>();
  let incomplete = false;
  await Promise.all(
    candidates.map(async (item) => {
      try {
        const proof = await readOneOriginalApprovalCard(item, ownerUserId, messageStore);
        if (proof) proofs.set(originalApprovalCardKey(item), proof);
        else incomplete = true;
      } catch {
        incomplete = true;
      }
    }),
  );
  return {
    proofs,
    reasons: incomplete ? ['original_approval_card_unverified'] : [],
  };
}

function isOriginalCardProducer(item: ApprovalHubItem): item is ApprovalHubItem & {
  sourceFeatureId: OriginalCardProducerId;
} {
  return Object.hasOwn(ORIGINAL_CARD_VALIDATORS, item.sourceFeatureId);
}

async function readOneOriginalApprovalCard(
  item: ApprovalHubItem & { sourceFeatureId: OriginalCardProducerId },
  ownerUserId: string,
  messageStore: OriginalApprovalCardMessageStore,
): Promise<UnifiedAttentionOriginalApprovalCard | null> {
  if (item.navigation.state !== 'anchored') return null;
  const { approvalCardRef } = item.navigation;
  const message = await messageStore.getById(approvalCardRef.messageId);
  if (message?.id !== approvalCardRef.messageId) return null;
  if (!liveMessageMatches(message, item, ownerUserId, approvalCardRef.threadId)) return null;

  const blocks = message.extra?.rich?.blocks ?? [];
  const validator = ORIGINAL_CARD_VALIDATORS[item.sourceFeatureId];
  const expectedBlockId = validator.blockId(item.proposalId);
  if (blocks.filter((candidate) => candidate.id === expectedBlockId).length !== 1) return null;
  const stamped = blocks.filter(hasIngressApprovalStamp);
  if (stamped.length !== 1) return null;
  const block = stamped[0];
  if (!isExactProducerCard(block, item, validator)) return null;
  return {
    cardRef: {
      threadId: approvalCardRef.threadId,
      messageId: approvalCardRef.messageId,
      blockId: block.id,
    },
    block: structuredClone(block),
  };
}

function liveMessageMatches(
  message: StoredMessage | null,
  item: ApprovalHubItem,
  ownerUserId: string,
  cardThreadId: string,
): message is StoredMessage {
  return Boolean(
    message &&
      !message.deletedAt &&
      !message._tombstone &&
      message.userId === ownerUserId &&
      message.threadId === cardThreadId &&
      message.catId === item.requesterCatId,
  );
}

function hasIngressApprovalStamp(block: RichBlock): block is RichCardBlock {
  return block.kind === 'card' && isRecord(block.meta?.approval);
}

function isExactProducerCard(
  block: RichCardBlock,
  item: ApprovalHubItem & { sourceFeatureId: OriginalCardProducerId },
  validator: OriginalCardValidator,
): boolean {
  const stamp = block.meta?.approval;
  if (!isRecord(stamp)) return false;
  if (
    Object.keys(stamp).length !== 2 ||
    stamp.producerId !== item.sourceFeatureId ||
    stamp.canonicalProposalId !== item.proposalId ||
    block.id !== validator.blockId(item.proposalId)
  ) {
    return false;
  }
  if (validator.family === 'informational') return isExactInformationalApprovalCard(block, item);
  if (!block.actions || block.actions.length !== validator.actions.length) return false;
  return validator.actions.every((actionName) => {
    const matches = block.actions?.filter((action) => action.action === actionName) ?? [];
    return matches.length === 1 && exactProposalPayload(matches[0]?.payload, item.proposalId);
  });
}

function exactProposalPayload(value: unknown, proposalId: string): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.proposalId === proposalId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
