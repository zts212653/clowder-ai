import { evolutionOwnerSurfaceBindingV1Schema, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';

/**
 * Request shapes for the F311 Program routes, kept apart from the handlers so the contract can be
 * read (and reviewed) on its own. The Phase 3 evaluation schema in particular carries a rule that
 * is easy to lose in handler noise: it accepts identities only, never owner verdicts.
 */

/** Canonical 2x2 coordinate order, so a rejudge matrix has exactly one serialisation. */
const REJUDGE_CELL_ORDER: Record<string, number> = {
  'previous/previous': 0,
  'previous/current': 1,
  'current/previous': 2,
  'current/current': 3,
};
const rejudgeCoordinate = (cell: { rubric: string; candidate: string }) => `${cell.rubric}/${cell.candidate}`;

/** Canonical layer order, so an attribution's candidate SET has exactly one serialisation. */
const ATTRIBUTION_LAYER_ORDER: Record<'execution' | 'harness' | 'rubric' | 'observation', number> = {
  execution: 0,
  harness: 1,
  rubric: 2,
  observation: 3,
};

export const bounded = (max: number) => z.string().trim().min(1).max(max);
export const clientMessageIdSchema = bounded(240);
export const programIdSchema = z.string().regex(/^evolution-program:[0-9a-f]{32}$/);
export const ownerRef = ownerTruthRefV1Schema;
export const createProgramSchema = z.object({ targetRef: ownerRef, clientMessageId: clientMessageIdSchema }).strict();
export const commandActionSchema = z.union([
  z.object({ type: z.literal('pause'), reasonRef: ownerRef }).strict(),
  z.object({ type: z.literal('resume'), resumeRef: ownerRef }).strict(),
  z
    .object({
      type: z.literal('needs_expert'),
      missingRole: z.enum(['observer', 'domain_owner', 'consumer', 'calibrator']),
      blockerRef: ownerRef,
    })
    .strict(),
  z.object({ type: z.literal('bind_expert'), roleOwnerRef: ownerRef }).strict(),
  z.object({ type: z.literal('withdraw'), decisionRef: ownerRef }).strict(),
  z
    .object({
      type: z.literal('retention'),
      mode: z.enum(['keep_forever', 'forget_after']),
      ttlSeconds: z.number().int().positive().max(31_536_000).optional(),
      retentionActionRef: ownerRef,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.mode === 'forget_after' && value.ttlSeconds === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ttlSeconds'],
          message: 'forget_after requires ttlSeconds',
        });
      }
      if (value.mode === 'keep_forever' && value.ttlSeconds !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ttlSeconds'],
          message: 'keep_forever forbids ttlSeconds',
        });
      }
    }),
  z
    .object({
      type: z.literal('forget'),
      ttlSeconds: z.number().int().positive().max(31_536_000),
      decisionRef: ownerRef,
      retentionActionRef: ownerRef,
    })
    .strict(),
]);
export const commandSchema = z
  .object({
    expectedSequence: z.number().int().nonnegative(),
    clientMessageId: clientMessageIdSchema,
    action: commandActionSchema,
  })
  .strict();
export const assetRef = z
  .object({
    ownerFeatureId: z.string().trim().min(1).max(120),
    ownerStateRef: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(240).optional(),
    assetKind: z.string().trim().min(1).max(120),
    assetId: z.string().trim().min(1).max(240),
  })
  .strict();
/**
 * Identity only. The verdict, cohort, baseline, exposure proof, uncertainty and per-layer
 * discrimination are resolved from F267 — a caller that could state them could manufacture an
 * attribution out of a well-shaped request.
 */
export const measurementRefsSchema = z.object({ evidenceProofRef: ownerRef }).strict();
export const evaluationSchema = z
  .object({
    expectedSequence: z.number().int().nonnegative(),
    clientMessageId: clientMessageIdSchema,
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('measurement'), measurement: measurementRefsSchema }).strict(),
      z
        .object({
          kind: z.literal('attribution'),
          measurement: measurementRefsSchema,
          attribution: z
            .object({
              /**
               * The rulers are NOT accepted here. The current one is read from this round's owner
               * proof and the previous one from what the Program itself recorded last round — a
               * caller able to state either could decide its own comparability. A rejudge cell names
               * the decision proof behind that cell, so the Program can verify the cell really sits
               * on the axis it claims.
               *
               * The cells are a SET of 2x2 coordinates, exactly like `candidates`: the matrix is
               * addressed by (rubric, candidate), never by position, so it is normalised to canonical
               * coordinate order here. Without that, the same completed matrix written in a different
               * order digested differently and a semantic retry came back as an idempotency
               * collision. One coordinate may be filled once — two cells for the same coordinate is
               * a caller error, not a merge.
               */
              rejudge: z
                .object({
                  cells: z
                    .array(
                      z
                        .object({
                          rubric: z.enum(['previous', 'current']),
                          candidate: z.enum(['previous', 'current']),
                          evidenceProofRef: ownerRef,
                        })
                        .strict(),
                    )
                    .max(16)
                    .refine((cells) => new Set(cells.map(rejudgeCoordinate)).size === cells.length, {
                      message: 'each rejudge coordinate may be filled at most once',
                    })
                    .transform((cells) =>
                      [...cells].sort(
                        (left, right) =>
                          (REJUDGE_CELL_ORDER[rejudgeCoordinate(left)] ?? 0) -
                          (REJUDGE_CELL_ORDER[rejudgeCoordinate(right)] ?? 0),
                      ),
                    ),
                })
                .strict()
                .optional(),
              baselineRebuildProofRef: ownerRef.optional(),
              /**
               * A SET of layers, not a sequence. Order carries no meaning in the diagnosis, so it is
               * normalised to canonical layer order here: otherwise the same command submitted with
               * the candidates written in a different order digests differently, and the ingress
               * disagrees with itself about whether a retry is a retry. A layer may appear once —
               * two candidates for one layer is a caller error, not a merge.
               */
              candidates: z
                .array(
                  z
                    .object({
                      layer: z.enum(['execution', 'harness', 'rubric', 'observation']),
                      evidenceRefs: z.array(ownerRef).max(64),
                    })
                    .strict(),
                )
                .max(4)
                .refine((entries) => new Set(entries.map((entry) => entry.layer)).size === entries.length, {
                  message: 'each attribution layer may be claimed at most once',
                })
                .transform((entries) =>
                  [...entries].sort(
                    (left, right) => ATTRIBUTION_LAYER_ORDER[left.layer] - ATTRIBUTION_LAYER_ORDER[right.layer],
                  ),
                ),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('intervention'),
          /**
           * Nothing but the request identity. The intervention card, the gate receipt and the
           * auto-recheck registration are owner-held; accepting them here would let a caller relabel
           * its own refs as F267's and walk through the gate. Until the owner contract publishes
           * them, the gate stays closed — which is the safe direction.
           */
          intervention: z.object({}).strict(),
        })
        .strict(),
    ]),
  })
  .strict();
/**
 * Constitution. These are governance pointers — which artifacts this Program is constituted around —
 * not owner verdicts. What the measurement certificate SAYS is never read from here: it is checked
 * later against the certificate F267's own verified proof is bound to.
 */
export const constitutionSchema = z
  .object({
    expectedSequence: z.number().int().nonnegative(),
    clientMessageId: clientMessageIdSchema,
    certificates: z.object({ goal: ownerRef, measurement: ownerRef, economic: ownerRef }).strict(),
    valueOwnerRef: ownerRef,
    measurementRoleRefs: z
      .object({
        observer: ownerRef,
        domainOwner: ownerRef,
        consumer: ownerRef,
        calibrator: ownerRef,
        overlapJustification: bounded(1_000).optional(),
      })
      .strict(),
  })
  .strict();

/**
 * Opening a round takes nothing but identities. The trigger receipt comes from F192's own dispatch
 * and the exposure proof from F267's projection — a caller that could state either could open a
 * round at will and discard the previous round's diagnosis.
 */
export const evaluationRoundSchema = z
  .object({
    expectedSequence: z.number().int().nonnegative(),
    clientMessageId: clientMessageIdSchema,
    evidenceProofRef: ownerRef,
  })
  .strict();

export const observationSchema = z
  .object({
    expectedSequence: z.number().int().nonnegative(),
    clientMessageId: clientMessageIdSchema,
    trajectoryRef: ownerRef,
    sourceBindings: z.array(evolutionOwnerSurfaceBindingV1Schema).min(1).max(128),
    evidenceProofRef: ownerRef,
  })
  .strict();
