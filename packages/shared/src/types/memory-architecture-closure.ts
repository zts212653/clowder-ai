import { z } from 'zod';

const bounded = (max: number) => z.string().trim().min(1).max(max);
const opaqueRefSchema = bounded(1_000);

export const MEMORY_SURFACE_DISPOSITIONS = ['active', 'exempt', 'sunset', 'missing'] as const;
export const MEMORY_SURFACE_ANSWER_STATES = ['implemented', 'exempt', 'sunset', 'missing'] as const;
export const MEMORY_EVIDENCE_LEVELS = ['docs-only', 'fixture', 'main', 'live', 'UAT'] as const;

export const memorySurfaceOwnerV1Schema = z
  .object({
    v: z.literal(1),
    surfaceId: bounded(120),
    label: bounded(160),
    ownerCell: bounded(160),
    ownerRefs: z.array(opaqueRefSchema).min(1).max(16),
    canonicalRefs: z.array(opaqueRefSchema).min(1).max(32),
    authority: bounded(1_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const path of findUnknownPlaceholder(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'unknown placeholders fail closed' });
    }
  });

const closureAnswerSchema = z
  .object({
    state: z.enum(MEMORY_SURFACE_ANSWER_STATES),
    summary: bounded(1_000),
    evidenceLevel: z.enum(MEMORY_EVIDENCE_LEVELS),
    evidenceRefs: z.array(opaqueRefSchema).max(32),
    breakClass: z.enum(['B0', 'B1', 'B2', 'B3', 'invalidation']).optional(),
    ownerRefs: z.array(opaqueRefSchema).max(16).optional(),
    nextAction: bounded(1_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'implemented' && value.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceRefs'],
        message: 'implemented answers need evidence',
      });
    }
    if (value.state === 'missing') {
      if (!value.breakClass) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['breakClass'],
          message: 'missing answers need a break class',
        });
      }
      if (!value.ownerRefs || value.ownerRefs.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerRefs'], message: 'missing answers need an owner' });
      }
      if (!value.nextAction) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nextAction'],
          message: 'missing answers need a next action',
        });
      }
    } else if (value.breakClass || value.ownerRefs || value.nextAction) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only missing answers carry remediation fields' });
    }
    if ((value.state === 'exempt' || value.state === 'sunset') && value.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceRefs'],
        message: 'absence dispositions need evidence',
      });
    }
  });

function findUnknownPlaceholder(value: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  if (typeof value === 'string') return /\bunknown\b/i.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findUnknownPlaceholder(item, [...path, index]));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findUnknownPlaceholder(item, [...path, key]));
  }
  return [];
}

export const memorySurfaceClosureV1Schema = z
  .object({
    v: z.literal(1),
    surfaceId: bounded(120),
    declarationRevision: bounded(160),
    disposition: z.enum(MEMORY_SURFACE_DISPOSITIONS),
    authority: closureAnswerSchema,
    writeCapture: closureAnswerSchema,
    typedCuePredicate: closureAnswerSchema,
    presentationDrill: closureAnswerSchema,
    consumerAllowedUse: closureAnswerSchema,
    consumptionReceipt: closureAnswerSchema,
    outcome: closureAnswerSchema,
    invalidation: closureAnswerSchema,
    evidence: z
      .object({
        level: z.enum(MEMORY_EVIDENCE_LEVELS),
        refs: z.array(opaqueRefSchema).min(1).max(32),
        limitations: bounded(1_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const answers = [
      value.authority,
      value.writeCapture,
      value.typedCuePredicate,
      value.presentationDrill,
      value.consumerAllowedUse,
      value.consumptionReceipt,
      value.outcome,
      value.invalidation,
    ];
    const states = answers.map((answer) => answer.state);
    if (value.disposition === 'active' && states.some((state) => state !== 'implemented')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disposition'],
        message: 'active requires every answer implemented',
      });
    }
    if (value.disposition === 'missing' && !states.includes('missing')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disposition'],
        message: 'missing needs at least one missing answer',
      });
    }
    if (value.disposition === 'exempt' && (!states.includes('exempt') || states.includes('missing'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disposition'],
        message: 'exempt needs an exemption and no missing answer',
      });
    }
    if (value.disposition === 'sunset' && (!states.includes('sunset') || states.includes('missing'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disposition'],
        message: 'sunset needs a sunset answer and no missing answer',
      });
    }
    for (const path of findUnknownPlaceholder(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'unknown placeholders fail closed' });
    }
  });

const recallFrameSourceSchema = z
  .object({
    sourceRef: opaqueRefSchema,
    sourceRevision: bounded(240),
    authorityRef: opaqueRefSchema,
    eligibilityRef: opaqueRefSchema,
  })
  .strict();

export const memoryRecallFrameV0Schema = z
  .object({
    v: z.literal(0),
    frameId: bounded(240),
    trigger: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('query'),
          queryRef: opaqueRefSchema,
          queryRevision: bounded(240),
        })
        .strict(),
      z
        .object({
          kind: z.literal('typed_event'),
          eventKind: bounded(160),
          eventRef: opaqueRefSchema,
          eventRevision: bounded(240),
        })
        .strict(),
    ]),
    predicateRevision: bounded(240),
    constructorRef: opaqueRefSchema,
    constructorRevision: bounded(240),
    sourceRefs: z.array(recallFrameSourceSchema).min(1).max(128),
    asOf: z.number().int().nonnegative().finite(),
    delivery: z
      .object({
        state: z.enum(['eligible_only', 'omitted', 'presented', 'drilled']),
        refs: z.array(opaqueRefSchema).min(1).max(64),
      })
      .strict(),
    application: z
      .object({
        state: z.enum(['not_observed', 'applied', 'dismissed', 'mixed']),
        refs: z.array(opaqueRefSchema).max(64),
      })
      .strict(),
    outcome: z
      .object({
        state: z.enum(['not_observed', 'observed']),
        refs: z.array(opaqueRefSchema).max(64),
      })
      .strict(),
    invalidation: z
      .object({
        state: z.enum(['none_observed', 'invalidated']),
        refs: z.array(opaqueRefSchema).max(64),
      })
      .strict(),
    materialization: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('ephemeral') }).strict(),
      z
        .object({
          mode: z.literal('persisted'),
          viewRef: opaqueRefSchema,
          derivedViewContractRef: z.literal('MemoryDerivedViewContract.v1'),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const requireRefs = (
      field: 'application' | 'outcome' | 'invalidation',
      absentState: 'not_observed' | 'none_observed',
    ) => {
      const answer = value[field];
      if (answer.state === absentState && answer.refs.length !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, 'refs'],
          message: 'unobserved state must have zero refs',
        });
      }
      if (answer.state !== absentState && answer.refs.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, 'refs'],
          message: 'observed state needs evidence refs',
        });
      }
    };
    requireRefs('application', 'not_observed');
    requireRefs('outcome', 'not_observed');
    requireRefs('invalidation', 'none_observed');
    const sourceKeys = value.sourceRefs.map((source) => `${source.sourceRef}\u0000${source.sourceRevision}`);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceRefs'],
        message: 'source ref/revision pairs must be unique',
      });
    }
  });

export type MemorySurfaceOwnerV1 = z.infer<typeof memorySurfaceOwnerV1Schema>;
export type MemorySurfaceClosureV1 = z.infer<typeof memorySurfaceClosureV1Schema>;
export type MemoryRecallFrameV0 = z.infer<typeof memoryRecallFrameV0Schema>;
