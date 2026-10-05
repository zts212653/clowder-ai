import { z } from 'zod';

export const developmentTaskRefSchema = z.string().regex(/^task:work:[A-Za-z0-9_-]{1,160}$/);
export const developmentRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const documentBasenamePattern = '[A-Za-z0-9][A-Za-z0-9_.-]*\\.md';
const planAnchorPattern = '[^\\s#\\x00-\\x1f\\x7f]{1,160}';
export const developmentPlanRefSchema = z
  .string()
  .max(512)
  .regex(new RegExp(`^file:docs/plans/${documentBasenamePattern}#${planAnchorPattern}$`));
const featureRef = z.string().regex(/^feature:F\d+$/);
// An exact declared key is one bounded token, not an alphabetic enum. Feature documents use
// compounds, suffixes and Unicode (A+, C/D, H1+H2, B-α, 2'); delimiters belong to the heading.
export const developmentPhaseKeyPattern = '[A-Z0-9][^\\s\\x00-\\x1f\\x7f:：（()）—–✅]{0,31}';
const phaseKey = z.string().regex(new RegExp(`^${developmentPhaseKeyPattern}$`));
const phaseRef = z.string().regex(new RegExp(`^feature-phase:F\\d+:${developmentPhaseKeyPattern}$`));

/** Identity comes from persistent owner references, never source-message IDs or prose. */
export const developmentScopeV1Schema = z
  .object({
    featureRef,
    phaseKey,
    workUnitRef: z.union([phaseRef, developmentTaskRefSchema, developmentPlanRefSchema]),
    acceptedSourceRef: z
      .string()
      .max(512)
      .regex(new RegExp(`^file:docs/(?:features|plans)/${documentBasenamePattern}(?:#${planAnchorPattern})?$`)),
    acceptedRevision: developmentRevisionSchema,
  })
  .strict()
  .superRefine((scope, ctx) => {
    if (
      scope.workUnitRef.startsWith('feature-phase:') &&
      scope.workUnitRef !== `feature-phase:${scope.featureRef.slice('feature:'.length)}:${scope.phaseKey}`
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['workUnitRef'],
        message: 'Phase work must reference this exact Feature and Phase',
      });
    }
  });

export type DevelopmentScopeV1 = z.infer<typeof developmentScopeV1Schema>;

/** Owner resolver fills workUnitRef and acceptedSourceRef after reading the revision. */
export const developmentScopeQueryV1Schema = z
  .object({
    featureRef,
    phaseKey,
    acceptedRevision: developmentRevisionSchema,
    workUnitRef: z.union([phaseRef, developmentTaskRefSchema, developmentPlanRefSchema]).optional(),
  })
  .strict()
  .refine(
    (query) =>
      !query.workUnitRef?.startsWith('feature-phase:') ||
      query.workUnitRef === `feature-phase:${query.featureRef.slice('feature:'.length)}:${query.phaseKey}`,
    { path: ['workUnitRef'], message: 'Phase work must reference this exact Feature and Phase' },
  );
export type DevelopmentScopeQueryV1 = z.infer<typeof developmentScopeQueryV1Schema>;
