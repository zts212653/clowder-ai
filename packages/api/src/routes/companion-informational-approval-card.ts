import { isDeepStrictEqual } from 'node:util';
import {
  ACTION_SUCCESSOR_ACTION_FAMILIES,
  ACTION_SUCCESSOR_SLOTS,
  ACTION_TERMINAL_PREDICATE_KINDS,
  type ApprovalHubItem,
  ENTITY_STANCES,
  type RichCardBlock,
  tasteMemoryCorrectionTargetSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { buildApprovalCardBlock } from '../domains/approval-hub/buildApprovalCardBlock.js';
import { buildDispatchProposalCardBlock } from './dispatch-proposal-card-block.js';
import { buildEntityProposalCardBlock } from './entity-proposal-card-block.js';
import { reconstructLegacyTasteProposalCard } from './legacy-taste-proposal-card.js';
import { buildTasteProposalCardBlock } from './taste-proposal-card-block.js';

const dispatchDetail = z.object({
  content: z.string(),
  targetThreadId: z.string(),
  targetCats: z.array(z.string()),
  actionFamily: z.enum(ACTION_SUCCESSOR_ACTION_FAMILIES).optional(),
  successorSlot: z.enum(ACTION_SUCCESSOR_SLOTS).optional(),
  mode: z.enum(['single', 'parallel']).optional(),
  subjectRef: z.string().optional(),
  terminalPredicate: z.object({ kind: z.enum(ACTION_TERMINAL_PREDICATE_KINDS) }).optional(),
});
const tasteDetail = z.object({
  scene: z.string(),
  quote: z.string(),
  quotes: z.array(z.string()).optional(),
  takeaway: z.string().optional(),
  tags: z.array(z.string()),
  dimension: z.enum([
    'relationship-stance',
    'cognitive-honesty',
    'architecture-aesthetics',
    'visual-quality',
    'authentic-expression',
    'system-philosophy',
    'creative-craft',
  ]),
  privacy: z.enum(['public', 'sensitive']),
  correction: tasteMemoryCorrectionTargetSchema.omit({ sourceAnchor: true }).optional(),
});
const entityDetail = z.object({
  entityId: z.string(),
  canonicalName: z.string(),
  rationale: z.string(),
  aliases: z.array(z.string()),
  entityType: z.enum(['person', 'cat', 'feature', 'concept', 'external']),
  stance: z.enum(ENTITY_STANCES),
});

/** Compare the entire immutable publication with the same read's canonical domain detail. No stored UI grants authority. */
export function isExactInformationalApprovalCard(block: RichCardBlock, item: ApprovalHubItem): boolean {
  if (block.actions !== undefined) return false;
  const candidates = [expectedDomainCard(item)];
  // Old immutable cards establish provenance, not consent to their truncated preview.
  // Chat/Inbox render fresh canonical detail and submit its digest before the original writer runs.
  if (item.sourceFeatureId === 'F221') candidates.push(expectedTasteCard(item, reconstructLegacyTasteProposalCard));
  return candidates.some(
    (expected) =>
      expected !== null &&
      isDeepStrictEqual(
        block,
        buildApprovalCardBlock({ producerId: item.sourceFeatureId, canonicalProposalId: item.proposalId }, expected),
      ),
  );
}

function expectedDomainCard(item: ApprovalHubItem): RichCardBlock | null {
  if (item.sourceFeatureId === 'F193') return expectedDispatchCard(item);
  if (item.sourceFeatureId === 'F221') return expectedTasteCard(item);
  if (item.sourceFeatureId === 'F260') {
    const parsed = entityDetail.safeParse(item.detail);
    return parsed.success
      ? buildEntityProposalCardBlock({ ...parsed.data, proposalId: item.proposalId, sourceCatId: item.requesterCatId })
      : null;
  }
  return null;
}

function expectedDispatchCard(item: ApprovalHubItem): RichCardBlock | null {
  const parsed = dispatchDetail.safeParse(item.detail);
  if (!parsed.success) return null;
  const detail = parsed.data;
  const hasAction = ['actionFamily', 'successorSlot', 'mode', 'subjectRef', 'terminalPredicate'].some(
    (key) => item.detail[key] !== undefined,
  );
  if (hasAction && (!detail.actionFamily || !detail.successorSlot || !detail.mode || !detail.subjectRef)) return null;
  return buildDispatchProposalCardBlock({
    ...detail,
    proposalId: item.proposalId,
    senderCatId: item.requesterCatId,
    ...(hasAction && detail.actionFamily && detail.successorSlot && detail.mode && detail.subjectRef
      ? {
          proposedAction: {
            actionFamily: detail.actionFamily,
            successorSlot: detail.successorSlot,
            mode: detail.mode,
            subjectRef: detail.subjectRef,
            terminalPredicate: detail.terminalPredicate,
          },
        }
      : {}),
  });
}

function expectedTasteCard(item: ApprovalHubItem, buildCard = buildTasteProposalCardBlock): RichCardBlock | null {
  const parsed = tasteDetail.safeParse(item.detail);
  if (!parsed.success) return null;
  // Validation must not reorder/trim the patch that the immutable builder serialized.
  const rawDetail = item.detail as z.infer<typeof tasteDetail>;
  return buildCard({
    ...parsed.data,
    id: item.proposalId,
    catId: item.requesterCatId,
    resolvedQuotes: parsed.data.quotes,
    correctionTarget: rawDetail.correction,
  });
}
