import {
  approvalProducerMeta,
  COLLECTION_SIGNAL_KINDS,
  PROFILE_UPDATE_TARGET_LAYERS,
  type ProfileUpdateProposal,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isSystemUserMessage } from '../domains/cats/services/stores/visibility.js';
export const profileUpdateInputSchema = z.object({
  afterContent: z.string().min(1).max(20000),
  rationale: z.string().trim().min(1).max(1000),
  signalKind: z.enum(COLLECTION_SIGNAL_KINDS),
  sourceMessageId: z.string().min(1).optional(),
  // Paths and identity are derived below; the cat can only choose a governed layer.
  targetLayer: z.enum(PROFILE_UPDATE_TARGET_LAYERS).default('primer'),
  expectedRevision: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  clientRequestId: z.string().min(1).max(200).optional(),
});

export type ProfileUpdateInput = z.infer<typeof profileUpdateInputSchema>;

/** F231 binds the thread to callback auth; preserve its catalogued system-wake exemption. */
export function isEligibleProfileOrigin(source: StoredMessage | null, userId: string, threadId: string): boolean {
  if (!source || source.deletedAt || source._tombstone || source.threadId !== threadId) return false;
  return (
    source.userId === userId ||
    (approvalProducerMeta('F231').systemOriginExemption === 'server_attested' && isSystemUserMessage(source))
  );
}

/** Compare against the original durable payload, never the newer live profile. */
export function profileUpdateRetryMatches(
  proposal: ProfileUpdateProposal,
  input: ProfileUpdateInput,
  record: { userId: string; catId: string; threadId: string },
): boolean {
  return (
    proposal.createdBy === record.userId &&
    proposal.sourceCatId === record.catId &&
    proposal.sourceThreadId === record.threadId &&
    proposal.signalProvenance.sourceThreadId === record.threadId &&
    (input.sourceMessageId === undefined || input.sourceMessageId === proposal.signalProvenance.sourceMessageId) &&
    proposal.targetLayer === input.targetLayer &&
    proposal.afterContent === input.afterContent &&
    proposal.rationale === input.rationale &&
    proposal.signalProvenance.kind === input.signalKind &&
    (input.expectedRevision === undefined || input.expectedRevision === `sha256:${proposal.baseContentHash}`)
  );
}
