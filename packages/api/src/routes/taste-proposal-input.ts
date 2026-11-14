import { isDeepStrictEqual } from 'node:util';
import { type TasteProposal, tasteMemoryCorrectionProposalInputSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { TasteMemoryLifecycleStore } from '../domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryReader } from '../domains/memory/taste/TasteMemoryReader.js';
import { sourcePathFromTasteAnchor } from '../domains/memory/taste/taste-memory-identity.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';
import type { CreateTasteProposalInput } from '../domains/taste/stores/ports/TasteProposalStore.js';

const createTasteSchema = z
  .object({
    scene: z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => value.trim().length > 0, 'scene must not be blank'),
    quote: z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => value.trim().length > 0, 'quote must not be blank'),
    takeaway: z.string().trim().min(1).max(500).optional(),
    tags: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(50)
          .refine((tag) => !/[\r\n]/.test(tag), 'a tag must be one line'),
      )
      .min(1)
      .max(10),
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
    sourceMessageId: z.string().min(1).optional(),
    clientRequestId: z.string().min(1).max(200),
  })
  .strict();

export const tasteProposalInputSchema = z.union([createTasteSchema, tasteMemoryCorrectionProposalInputSchema]);
export type TasteProposalInput = z.infer<typeof tasteProposalInputSchema>;
export type ResolvedTasteProposalInput = Omit<
  CreateTasteProposalInput,
  'proposalId' | 'userId' | 'catId' | 'threadId' | 'approvalOriginRef' | 'clientRequestId'
> & { clientRequestId: string };
export type TasteInputFailure = { statusCode: number; body: Record<string, unknown> };

export async function resolveTasteProposalInput(
  input: TasteProposalInput,
  userId: string,
  originMessageId: string,
  deps: { tasteRepository?: TasteRepository; lifecycleStore?: Pick<TasteMemoryLifecycleStore, 'isReadable'> },
): Promise<ResolvedTasteProposalInput | TasteInputFailure> {
  if (!('target' in input)) return { ...input, sourceMessageId: originMessageId };
  if (!deps.tasteRepository) return { statusCode: 503, body: { error: 'Taste source unavailable' } };
  const sourcePath = sourcePathFromTasteAnchor(input.target.sourceAnchor);
  if (!sourcePath) return { statusCode: 400, body: { error: 'Invalid Taste correction target' } };
  const memory = await new TasteMemoryReader(deps.tasteRepository, userId, { lifecycle: deps.lifecycleStore }).read({
    ownerUserId: userId,
    sourcePath,
    revision: input.target.expectedRevision,
  });
  if (!memory)
    return { statusCode: 409, body: { error: 'Taste source changed or is unavailable', code: 'stale_revision' } };
  const patch = input.target.suggestedPatch;
  const dimension = patch.dimension ?? memory.payload.dimension;
  if (!dimension)
    return { statusCode: 409, body: { error: 'Taste source has no reviewable dimension', code: 'not_available' } };
  const quotes = patch.quotes ?? memory.payload.quotes;
  return {
    scene: patch.scene ?? memory.payload.scene,
    quote: quotes[0] ?? memory.payload.quotes[0] ?? '',
    resolvedQuotes: [...quotes],
    ...(patch.takeaway === null ? {} : { takeaway: patch.takeaway ?? memory.payload.takeaway }),
    tags: patch.tags ?? memory.payload.tags,
    dimension,
    privacy: memory.visibility === 'private' ? 'sensitive' : 'public',
    sourceMessageId: originMessageId,
    clientRequestId: input.clientRequestId,
    correctionTarget: input.target,
  };
}

/** A correction retry compares its original command, never the changed live vignette. */
export function tasteProposalRetryMatches(
  proposal: TasteProposal,
  input: TasteProposalInput,
  caller: { userId: string; catId: string; threadId: string },
): boolean {
  if (proposal.userId !== caller.userId || proposal.catId !== caller.catId || proposal.threadId !== caller.threadId)
    return false;
  if ('target' in input) return isDeepStrictEqual(proposal.correctionTarget, input.target);
  return (
    !proposal.correctionTarget &&
    (input.sourceMessageId === undefined || input.sourceMessageId === proposal.sourceMessageId) &&
    proposal.scene === input.scene &&
    proposal.quote === input.quote &&
    proposal.takeaway === input.takeaway &&
    isDeepStrictEqual(proposal.tags, input.tags) &&
    proposal.dimension === input.dimension &&
    proposal.privacy === input.privacy
  );
}
