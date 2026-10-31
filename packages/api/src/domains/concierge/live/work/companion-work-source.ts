import { messageMediaItemSelectorSchema } from '@cat-cafe/shared';
import { z } from 'zod';

const ref = z.string().trim().min(1).max(1_000);
const time = z.number().int().nonnegative();
const version = z
  .object({
    contentRef: ref,
    ownerRevision: z.number().int().positive(),
    currentOwnerRevision: z.number().int().positive(),
  })
  .refine((value) => value.ownerRevision <= value.currentOwnerRevision);

export const companionArtifactsSource = z
  .object({
    total: z.number().int().nonnegative(),
    complete: z.boolean(),
    workLineage: z.enum(['resolved', 'unavailable']),
    artifacts: z.array(
      z.object({
        type: z.enum(['image', 'file', 'video']),
        name: z.string(),
        catId: ref,
        createdAt: time,
        threadId: ref,
        threadTitle: z.string(),
        sourceMessageId: ref.nullable(),
        publicationItem: messageMediaItemSelectorSchema,
        url: z.string().max(2_048).optional(),
        ref: z.string().max(2_048).optional(),
        fileLedgerRef: z.string().optional(),
        work: version.optional(),
      }),
    ),
  })
  .refine((value) => value.total === value.artifacts.length);

export type CompanionArtifactSource = z.infer<typeof companionArtifactsSource>;

export function observedSourceStatus(sources: readonly { status: 'available' | 'partial' | 'unavailable' }[]) {
  if (sources.every((source) => source.status === 'unavailable')) return 'unavailable' as const;
  if (sources.some((source) => source.status !== 'available')) return 'partial' as const;
  return 'available' as const;
}
