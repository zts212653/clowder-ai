import {
  EVOLUTION_PREPARATION_SECTIONS,
  type EvolutionPreparationSubmissionRefV1,
  evolutionPreparationActivityRefV1Schema,
  evolutionPreparationSectionSchema,
  evolutionPreparationSubmissionRefCoordinates,
  evolutionPreparationSubmissionRefV1Schema,
  evolutionPreparationSubmissionV1Schema,
  ownerTruthRefV1Schema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const sourceStatusSchema = z.enum([
  'materializing',
  'submitted',
  'needs_update',
  'source_unavailable',
  'source_invalid',
]);
const activityStateSchema = z.enum(['active', 'terminal', 'unknown', 'identity_invalid', 'superseded_by_submission']);
const identity = z.string().trim().min(1).max(512);
const timestamp = z.string().datetime({ offset: true });

function refKey(ref: EvolutionPreparationSubmissionRefV1): string {
  return `${ref.ownerFeatureId}:${ref.ownerStateRef}:${ref.version ?? ''}`;
}

const submissionProjectionSchema = z
  .object({
    ref: evolutionPreparationSubmissionRefV1Schema,
    section: evolutionPreparationSectionSchema,
    status: sourceStatusSchema,
    occurredAt: timestamp,
    clientMessageId: identity,
    threadId: identity.optional(),
    authorCatId: identity.optional(),
    messageId: identity.optional(),
    sourceMessageId: identity.optional(),
    dependencies: z.array(evolutionPreparationSubmissionRefV1Schema).max(3),
    staleDependencies: z.array(evolutionPreparationSubmissionRefV1Schema).max(3),
    submission: evolutionPreparationSubmissionV1Schema.optional(),
    inputSources: z
      .array(
        z
          .object({
            itemId: identity,
            threadId: identity,
            messageId: identity,
            status: z.enum(['available', 'unavailable']),
            author: z.literal('human').optional(),
            occurredAt: timestamp.optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    evidenceSources: z
      .array(
        z
          .object({
            sourceKey: identity,
            status: z.enum(['available', 'unavailable', 'unverified']),
            refs: z
              .array(
                z
                  .object({
                    ref: ownerTruthRefV1Schema,
                    status: z.enum(['available', 'unavailable', 'unverified']),
                    threadId: identity.optional(),
                    messageId: identity.optional(),
                  })
                  .strict(),
              )
              .max(17),
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const coordinates = evolutionPreparationSubmissionRefCoordinates(value.ref);
    if (!coordinates || coordinates.section !== value.section) {
      ctx.addIssue({ code: 'custom', path: ['ref'], message: 'submission ref does not match its section' });
    }
    const dependencyKeys = new Set(value.dependencies.map(refKey));
    if (value.staleDependencies.some((ref) => !dependencyKeys.has(refKey(ref)))) {
      ctx.addIssue({ code: 'custom', path: ['staleDependencies'], message: 'stale refs must be dependencies' });
    }
    const resolved = value.status === 'submitted' || value.status === 'needs_update';
    if (resolved !== Boolean(value.submission)) {
      ctx.addIssue({ code: 'custom', path: ['submission'], message: 'only resolved sources may expose a body' });
    }
    if (value.status === 'submitted' && value.staleDependencies.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'a submitted source cannot have stale dependencies' });
    }
    if (value.status === 'needs_update' && value.staleDependencies.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'needs_update requires a stale dependency' });
    }
    if (value.submission) {
      const sameDependencies =
        value.dependencies.length === value.submission.dependsOn.length &&
        value.dependencies.every((ref, index) => {
          const dependency = value.submission?.dependsOn[index];
          return dependency !== undefined && refKey(ref) === refKey(dependency);
        });
      if (
        value.submission.section !== value.section ||
        value.submission.revision !== value.ref.version ||
        value.submission.authorCatId !== value.authorCatId ||
        !value.threadId ||
        !value.messageId ||
        !sameDependencies
      ) {
        ctx.addIssue({ code: 'custom', path: ['submission'], message: 'resolved body does not match its event refs' });
      }
    }
  });

const activityProjectionSchema = z
  .object({
    activityRef: evolutionPreparationActivityRefV1Schema,
    section: evolutionPreparationSectionSchema,
    itemId: identity.optional(),
    focus: z.string().trim().min(1).max(2_000),
    baseSubmissionRef: evolutionPreparationSubmissionRefV1Schema.optional(),
    occurredAt: timestamp,
    state: activityStateSchema,
    spinning: z.boolean(),
    invocationId: identity,
    threadId: identity.optional(),
    catId: identity.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const activityInvocation = value.activityRef.ownerStateRef.slice('invocation:'.length);
    if (activityInvocation !== value.invocationId) {
      ctx.addIssue({ code: 'custom', path: ['invocationId'], message: 'activity invocation identity drifted' });
    }
    if (value.spinning !== (value.state === 'active')) {
      ctx.addIssue({ code: 'custom', path: ['spinning'], message: 'only a live invocation may spin' });
    }
    if (['active', 'terminal', 'superseded_by_submission'].includes(value.state) && (!value.catId || !value.threadId)) {
      ctx.addIssue({ code: 'custom', path: ['catId'], message: 'attributed activity requires its cat and thread' });
    }
  });

const sectionProjectionSchema = z
  .object({
    section: evolutionPreparationSectionSchema,
    identityRef: ownerTruthRefV1Schema,
    current: submissionProjectionSchema.nullable(),
    history: z.array(submissionProjectionSchema).max(128),
    activities: z.array(activityProjectionSchema).max(256),
  })
  .strict();

type SectionProjection = z.infer<typeof sectionProjectionSchema>;
type SubmissionProjection = z.infer<typeof submissionProjectionSchema>;

const preparationProjectionBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    programId: z.string().regex(/^evolution-program:[0-9a-f]{32}$/),
    sections: z
      .object({
        object_map: sectionProjectionSchema,
        success_contract: sectionProjectionSchema,
        measurement_plan: sectionProjectionSchema,
        baseline_diagnosis: sectionProjectionSchema,
      })
      .strict(),
  })
  .strict();
type PreparationProjectionShape = z.infer<typeof preparationProjectionBaseSchema>;

function coordinatesMatch(
  ref: EvolutionPreparationSubmissionRefV1,
  programId: string,
  section: SectionProjection['section'],
): boolean {
  const coordinates = evolutionPreparationSubmissionRefCoordinates(ref);
  return Boolean(coordinates && coordinates.programId === programId && coordinates.section === section);
}

function sectionIdentityMatches(
  programId: string,
  section: SectionProjection['section'],
  view: SectionProjection,
): boolean {
  return (
    view.section === section &&
    view.identityRef.ownerFeatureId === 'F311' &&
    view.identityRef.ownerStateRef === `preparation-submission:${programId}:${section}` &&
    view.identityRef.version === undefined
  );
}

function submissionIdentityMatches(
  programId: string,
  section: SectionProjection['section'],
  projected: SubmissionProjection,
): boolean {
  return (
    projected.section === section &&
    coordinatesMatch(projected.ref, programId, section) &&
    (projected.submission === undefined || projected.submission.programId === programId)
  );
}

function expectedStaleKeys(
  value: PreparationProjectionShape,
  section: SectionProjection['section'],
  projected: SubmissionProjection,
): Set<string> | undefined {
  const stale = new Set<string>();
  for (const dependency of projected.dependencies) {
    const coordinates = evolutionPreparationSubmissionRefCoordinates(dependency);
    if (!coordinates || coordinates.programId !== value.programId || coordinates.section === section) return undefined;
    const current = value.sections[coordinates.section].current?.ref;
    if (!current || refKey(current) !== refKey(dependency)) stale.add(refKey(dependency));
  }
  return stale;
}

function sameKeys(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function activityIdentityMatches(
  programId: string,
  section: SectionProjection['section'],
  activity: SectionProjection['activities'][number],
): boolean {
  return (
    activity.section === section &&
    (!activity.baseSubmissionRef || coordinatesMatch(activity.baseSubmissionRef, programId, section))
  );
}

function validateSubmissions(
  value: PreparationProjectionShape,
  section: SectionProjection['section'],
  view: SectionProjection,
  ctx: z.RefinementCtx,
) {
  const submissions = [...(view.current ? [view.current] : []), ...view.history];
  const uniqueRefs = new Set<string>();
  for (const projected of submissions) {
    if (!submissionIdentityMatches(value.programId, section, projected)) {
      ctx.addIssue({ code: 'custom', path: ['sections', section], message: 'submission escaped its section' });
    }
    const key = refKey(projected.ref);
    if (uniqueRefs.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['sections', section], message: 'submission revisions must be unique' });
    }
    uniqueRefs.add(key);
    const expected = expectedStaleKeys(value, section, projected);
    const projectedStaleKeys = new Set(projected.staleDependencies.map(refKey));
    if (!expected || !sameKeys(expected, projectedStaleKeys)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections', section],
        message: 'dependency freshness does not match current exact revisions',
      });
    }
  }
}

function validateActivities(
  programId: string,
  section: SectionProjection['section'],
  activities: SectionProjection['activities'],
  ctx: z.RefinementCtx,
) {
  for (const activity of activities) {
    if (!activityIdentityMatches(programId, section, activity)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections', section, 'activities'],
        message: 'activity escaped its Program or section',
      });
    }
  }
}

function validateSection(
  value: PreparationProjectionShape,
  section: SectionProjection['section'],
  ctx: z.RefinementCtx,
) {
  const view = value.sections[section];
  if (!sectionIdentityMatches(value.programId, section, view)) {
    ctx.addIssue({ code: 'custom', path: ['sections', section], message: 'section identity drifted' });
  }
  validateSubmissions(value, section, view, ctx);
  validateActivities(value.programId, section, view.activities, ctx);
}

const preparationProjectionSchema = preparationProjectionBaseSchema.superRefine((value, ctx) => {
  for (const section of EVOLUTION_PREPARATION_SECTIONS) validateSection(value, section, ctx);
});

export type EvolutionPreparationSubmissionProjection = z.infer<typeof submissionProjectionSchema>;
export type EvolutionPreparationActivityProjection = z.infer<typeof activityProjectionSchema>;
export type EvolutionPreparationSectionProjection = z.infer<typeof sectionProjectionSchema>;
export type EvolutionPreparationProjection = z.infer<typeof preparationProjectionSchema>;

export function parseEvolutionPreparationProjection(
  value: unknown,
  expectedProgramId: string,
): EvolutionPreparationProjection | null {
  const parsed = preparationProjectionSchema.safeParse(value);
  return parsed.success && parsed.data.programId === expectedProgramId ? parsed.data : null;
}

export function isVisiblePreparationSubmission(
  value: EvolutionPreparationSubmissionProjection | null | undefined,
): value is EvolutionPreparationSubmissionProjection & {
  submission: NonNullable<EvolutionPreparationSubmissionProjection['submission']>;
} {
  return Boolean(value?.submission) && (value?.status === 'submitted' || value?.status === 'needs_update');
}
