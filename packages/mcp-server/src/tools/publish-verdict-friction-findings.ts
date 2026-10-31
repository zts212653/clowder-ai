import { z } from 'zod';

const approvalRequirementShape = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('required'),
      reason: z.enum(['repair', 'accept_no_change', 'extend_budget', 'change_scope', 'change_owner']),
    })
    .strict(),
  z.object({ kind: z.literal('not_required') }).strict(),
]);

const frictionAnalysisFindingShape = z
  .object({
    candidateRef: z.string().min(1),
    findingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    analysisDisposition: z.enum(['repair', 'no_repair', 'observe', 'insufficient']),
    approvalRequirement: approvalRequirementShape,
    interventionKind: z.enum(['fix', 'build', 'delete_sunset']).optional(),
    rationale: z.string().min(1),
    uncertainty: z.enum(['low', 'medium', 'high']),
    falsifier: z.object({ condition: z.string().min(1), evidenceRef: z.string().min(1) }).strict(),
    withdrawalCondition: z.string().min(1),
    measurementResultRef: z.string().min(1),
    sourceSignalRefs: z.array(z.string().min(1)).min(1),
    repairTargetHint: z
      .object({
        featureId: z.string().regex(/^F\d{3}$/),
        componentId: z.string().min(1).optional(),
      })
      .strict()
      .describe('Untrusted feature/component hint only; owner/version/resolutionRef/resolvedAt are server-derived.'),
  })
  .strict()
  .superRefine((finding, ctx) => {
    if (finding.analysisDisposition === 'repair') {
      if (!finding.interventionKind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['interventionKind'],
          message: 'repair requires interventionKind',
        });
      }
      if (finding.approvalRequirement.kind !== 'required' || finding.approvalRequirement.reason !== 'repair') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvalRequirement'],
          message: 'repair requires Approval',
        });
      }
    } else if (finding.interventionKind !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interventionKind'],
        message: 'non-repair cannot carry interventionKind',
      });
    }
  });

export const frictionAnalysisFindingsShape = z
  .array(frictionAnalysisFindingShape)
  .min(1)
  .optional()
  .describe(
    'eval:friction only. One typed judgment per actionable candidate. Caller supplies target hints; API resolves owner/version/evidence refs.',
  );
