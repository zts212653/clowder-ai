import { z } from 'zod';
import { memoryRecallFrameV0Schema } from './memory-architecture-closure.js';

const opaqueRef = z.string().trim().min(1).max(1_000);
const sha256Revision = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const recurrenceOutcomeSchema = z
  .object({
    kind: z.literal('recurrence'),
    state: z.enum(['avoided', 'recurred']),
    applicationRef: opaqueRef,
    outcomeRef: opaqueRef,
    observationWindow: z
      .object({
        kind: z.literal('same_operation'),
        operationRef: opaqueRef,
        startsAtRef: opaqueRef,
        endsAtRef: opaqueRef,
      })
      .strict(),
    matchingAttempts: z.number().int().positive(),
    recurrentAttempts: z.number().int().nonnegative(),
    attributionCeiling: z.literal('guarded_same_operation_association'),
    confounders: z.tuple([z.literal('guard_enforcement')]),
    evidenceRefs: z.array(opaqueRef).min(1).max(16),
    limitations: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.recurrentAttempts > value.matchingAttempts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recurrentAttempts'],
        message: 'recurrent attempts cannot exceed matching attempts',
      });
    }
    if (value.state === 'avoided' && value.recurrentAttempts !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recurrentAttempts'],
        message: 'avoided requires zero recurrent attempts',
      });
    }
    if (value.state === 'recurred' && value.recurrentAttempts === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recurrentAttempts'],
        message: 'recurred requires at least one recurrent attempt',
      });
    }
  });

export const lessonConsumptionReplayV1Schema = z
  .object({
    v: z.literal(1),
    surfaceId: z.literal('lessons-learned'),
    contractRevision: z.literal('LessonConsumptionReplay.v1'),
    predicate: z
      .object({
        id: z.literal('worktree_redis_sanctuary_preflight'),
        revision: z.literal('LessonPredicate.worktree-redis-sanctuary-preflight.v1'),
        producer: z.literal('start_dev_preflight'),
        eventKind: z.literal('worktree_redis_sanctuary_preflight'),
        sourceRef: z.literal('scripts/start-dev.sh#guard_runtime_redis_sanctuary'),
        match: z
          .object({
            deploymentClass: z.literal('worktree'),
            resolvedRedisPort: z.literal(6399),
            phase: z.literal('before_storage_start'),
          })
          .strict(),
      })
      .strict(),
    source: z
      .object({
        lessonRef: z.literal('LL-015'),
        canonicalRef: z.literal('docs/lessons-learned.md'),
        lessonRevision: sha256Revision,
      })
      .strict(),
    receipt: memoryRecallFrameV0Schema,
    recurrenceOutcome: recurrenceOutcomeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const { receipt, predicate, source, recurrenceOutcome } = value;
    if (
      receipt.trigger.kind !== 'typed_event' ||
      receipt.trigger.eventKind !== predicate.eventKind ||
      receipt.predicateRevision !== predicate.revision
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipt', 'trigger'],
        message: 'receipt must bind the exact typed predicate revision',
      });
    }
    const expectedSourceRef = `lesson://${source.lessonRef}`;
    const expectedEligibilityRef = `lesson-predicate://${predicate.revision}`;
    const sourceBound =
      receipt.sourceRefs.length === 1 &&
      receipt.sourceRefs[0]?.sourceRef === expectedSourceRef &&
      receipt.sourceRefs[0]?.sourceRevision === source.lessonRevision &&
      receipt.sourceRefs[0]?.authorityRef === source.canonicalRef &&
      receipt.sourceRefs[0]?.eligibilityRef === expectedEligibilityRef;
    if (!sourceBound) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipt', 'sourceRefs'],
        message: 'receipt must bind the exact canonical Lesson revision',
      });
    }
    if (!['presented', 'drilled'].includes(receipt.delivery.state)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipt', 'delivery', 'state'],
        message: 'application receipts require presentation or drill evidence',
      });
    }
    if (!['applied', 'dismissed'].includes(receipt.application.state)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipt', 'application', 'state'],
        message: 'Lesson replay must settle applied or dismissed',
      });
    }
    if (
      receipt.constructorRef !== 'LessonLaneReplay.worktree_redis_sanctuary_preflight' ||
      receipt.constructorRevision !== value.contractRevision ||
      receipt.materialization.mode !== 'ephemeral'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipt'],
        message: 'Lesson replay must use the refs-only lane adapter without a persisted projection',
      });
    }
    if (!receipt.application.refs.includes(recurrenceOutcome.applicationRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recurrenceOutcome', 'applicationRef'],
        message: 'recurrence must join the exact application receipt',
      });
    }
    if (receipt.outcome.state !== 'observed' || !receipt.outcome.refs.includes(recurrenceOutcome.outcomeRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recurrenceOutcome', 'outcomeRef'],
        message: 'recurrence must join the exact observed outcome receipt',
      });
    }
    if (recurrenceOutcome.observationWindow.startsAtRef !== recurrenceOutcome.applicationRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recurrenceOutcome', 'observationWindow', 'startsAtRef'],
        message: 'causal window must start at the application receipt',
      });
    }
  });

export type LessonConsumptionReplayV1 = z.infer<typeof lessonConsumptionReplayV1Schema>;
