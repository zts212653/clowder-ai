import { z } from 'zod';

const sourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('direct_edit'),
      role: z.literal('canonical_candidate'),
      promotion: z.literal('reviewed_canonical_patch'),
      sourceRef: z.literal('docs/lessons-learned.md'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('f102_marker'),
      role: z.literal('candidate_only'),
      promotion: z.literal('reviewed_canonical_patch'),
      sourceRef: z.literal('packages/api/src/domains/memory/MaterializationService.ts'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('f152_distillation'),
      role: z.literal('downstream_only'),
      promotion: z.literal('forbidden'),
      sourceRef: z.literal('packages/api/src/domains/memory/distillation-service.ts'),
    })
    .strict(),
]);

const nonAuthoritySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scanner'), capability: z.literal('discovery_only') }).strict(),
  z.object({ kind: z.literal('index'), capability: z.literal('discovery_only') }).strict(),
  z.object({ kind: z.literal('f200_consumed'), capability: z.literal('observation_only') }).strict(),
]);

function requireExactKinds(
  values: ReadonlyArray<{ kind: string }>,
  expected: readonly string[],
  path: string,
  ctx: z.RefinementCtx,
): void {
  const actual = values.map((value) => value.kind).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `${path} must contain exactly ${wanted.join(', ')}`,
    });
  }
}

export const lessonPromotionContractV1Schema = z
  .object({
    v: z.literal(1),
    surfaceId: z.literal('lessons-learned'),
    contractRevision: z.literal('LessonPromotionContract.v1'),
    canonical: z
      .object({
        targetRef: z.literal('docs/lessons-learned.md'),
        writer: z.literal('reviewed_git_patch'),
        entryPattern: z.literal('^LL-\\d{3}$'),
      })
      .strict(),
    dedupe: z
      .object({
        keyRevision: z.literal('LessonClaimFamily.v1'),
        keyFields: z.tuple([z.literal('subsystem'), z.literal('failureMode'), z.literal('violatedInvariant')]),
        sameKeyAction: z.literal('update_existing'),
        conflictAction: z.literal('review_supersede_or_reject'),
        automaticSemanticMerge: z.literal('forbidden'),
      })
      .strict(),
    sources: z.array(sourceSchema).length(3),
    nonAuthorities: z.array(nonAuthoritySchema).length(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireExactKinds(value.sources, ['direct_edit', 'f102_marker', 'f152_distillation'], 'sources', ctx);
    requireExactKinds(value.nonAuthorities, ['scanner', 'index', 'f200_consumed'], 'nonAuthorities', ctx);
  });

export type LessonPromotionContractV1 = z.infer<typeof lessonPromotionContractV1Schema>;
