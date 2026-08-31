import { z } from 'zod';
import type { CatId } from './ids.js';

export interface CatAlternative {
  readonly catId: CatId;
  readonly mention: string;
  readonly displayName: string;
  readonly family: string;
}

export type CatRoutingError =
  | { kind: 'cat_not_found'; mention: string; alternatives: CatAlternative[] }
  | { kind: 'cat_disabled'; catId: CatId; displayName: string; alternatives: CatAlternative[] }
  | { kind: 'target_not_in_thread'; catId: CatId; threadId: string }
  | { kind: 'mention_ambiguous'; mention: string; candidates: CatAlternative[] }
  | { kind: 'suppressed_by_terminal_ack'; droppedMentions: CatId[] };

const NonEmptyStringSchema = z.string().min(1);
const CatIdSchema = NonEmptyStringSchema.transform((value) => value as CatId);

export const CatAlternativeSchema: z.ZodType<CatAlternative, z.ZodTypeDef, unknown> = z
  .object({
    catId: CatIdSchema,
    mention: NonEmptyStringSchema,
    displayName: NonEmptyStringSchema,
    family: NonEmptyStringSchema,
  })
  .strict();

/** Runtime counterpart of CatRoutingError for ingress and persistence boundaries. */
export const CatRoutingErrorSchema: z.ZodType<CatRoutingError, z.ZodTypeDef, unknown> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cat_not_found'),
      mention: NonEmptyStringSchema,
      alternatives: z.array(CatAlternativeSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cat_disabled'),
      catId: CatIdSchema,
      displayName: NonEmptyStringSchema,
      alternatives: z.array(CatAlternativeSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('target_not_in_thread'),
      catId: CatIdSchema,
      threadId: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('mention_ambiguous'),
      mention: NonEmptyStringSchema,
      candidates: z.array(CatAlternativeSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('suppressed_by_terminal_ack'),
      droppedMentions: z.array(CatIdSchema),
    })
    .strict(),
]);
