import { createHash } from 'node:crypto';
import { z } from 'zod';

const findingKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/, 'findingKey must be a stable lowercase domain-local slug');
const featureIdSchema = z.string().regex(/^F\d{3}$/, 'featureId must match F followed by 3 digits');
const nonEmptyRefArraySchema = z.array(z.string().trim().min(1)).min(1);

export const RepairTargetHintV1Schema = z
  .object({
    featureId: featureIdSchema,
    componentId: z.string().trim().min(1).optional(),
  })
  .strict();
export type RepairTargetHintV1 = z.infer<typeof RepairTargetHintV1Schema>;

export const ApprovalRequirementV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('required'),
      reason: z.enum(['repair', 'accept_no_change', 'extend_budget', 'change_scope', 'change_owner']),
    })
    .strict(),
  z.object({ kind: z.literal('not_required') }).strict(),
]);

export const ResolvedRepairTargetV1Schema = z
  .object({
    featureId: featureIdSchema,
    ownerCatId: z.string().trim().min(1),
    componentId: z.string().trim().min(1).optional(),
    version: z.string().regex(/^repair-target-v1-[a-f0-9]{64}$/),
    resolutionRef: z.string().trim().min(1),
    resolvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ResolvedRepairTargetV1 = z.infer<typeof ResolvedRepairTargetV1Schema>;

export const FrictionAnalysisFindingInputV1Schema = z
  .object({
    candidateRef: z.string().trim().min(1),
    findingKey: findingKeySchema,
    analysisDisposition: z.enum(['repair', 'no_repair', 'observe', 'insufficient']),
    approvalRequirement: ApprovalRequirementV1Schema,
    interventionKind: z.enum(['fix', 'build', 'delete_sunset']).optional(),
    rationale: z.string().trim().min(1),
    uncertainty: z.enum(['low', 'medium', 'high']),
    falsifier: z
      .object({
        condition: z.string().trim().min(1),
        evidenceRef: z.string().trim().min(1),
      })
      .strict(),
    withdrawalCondition: z.string().trim().min(1),
    measurementResultRef: z.string().trim().min(1),
    sourceSignalRefs: nonEmptyRefArraySchema,
    repairTargetHint: RepairTargetHintV1Schema,
  })
  .strict()
  .superRefine((finding, ctx) => {
    if (finding.analysisDisposition === 'repair') {
      if (!finding.interventionKind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['interventionKind'],
          message: 'repair disposition requires interventionKind',
        });
      }
      if (finding.approvalRequirement.kind !== 'required' || finding.approvalRequirement.reason !== 'repair') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvalRequirement'],
          message: 'repair disposition requires Approval reason repair',
        });
      }
      return;
    }
    if (finding.interventionKind !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interventionKind'],
        message: 'interventionKind is only valid for repair disposition',
      });
    }
    if (finding.approvalRequirement.kind === 'required' && finding.approvalRequirement.reason === 'repair') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalRequirement'],
        message: 'Approval reason repair is only valid for repair disposition',
      });
    }
  });

export type FrictionAnalysisFindingInputV1 = z.infer<typeof FrictionAnalysisFindingInputV1Schema>;

const repairTargetResolutionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), target: ResolvedRepairTargetV1Schema }).strict(),
  z
    .object({
      status: z.literal('blocked'),
      reason: z.enum(['owner_unresolved', 'owner_ambiguous', 'target_mismatch']),
      evidenceRef: z.string().trim().min(1),
    })
    .strict(),
]);

export type FrictionRepairTargetResolution = z.infer<typeof repairTargetResolutionSchema>;

export const FrictionAnalysisFindingV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    parentVerdictId: z.string().trim().min(1),
    domainId: z.literal('eval:friction'),
    candidateRef: z.string().trim().min(1),
    findingKey: findingKeySchema,
    analysisDisposition: z.enum(['repair', 'no_repair', 'observe', 'insufficient']),
    approvalRequirement: ApprovalRequirementV1Schema,
    interventionKind: z.enum(['fix', 'build', 'delete_sunset']).optional(),
    rationale: z.string().trim().min(1),
    uncertainty: z.enum(['low', 'medium', 'high']),
    falsifier: z.object({ condition: z.string().trim().min(1), evidenceRef: z.string().trim().min(1) }).strict(),
    withdrawalCondition: z.string().trim().min(1),
    measurementResultRef: z.string().trim().min(1),
    sourceSignalRefs: nonEmptyRefArraySchema,
    repairTargetResolution: repairTargetResolutionSchema,
  })
  .strict();

export type FrictionAnalysisFindingV1 = z.infer<typeof FrictionAnalysisFindingV1Schema>;

export const FindingBindingV1Schema = z
  .object({
    artifactRef: z.string().trim().min(1),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    analysisDisposition: z.enum(['repair', 'no_repair', 'observe', 'insufficient']),
    approvalRequirement: ApprovalRequirementV1Schema,
  })
  .strict();

export type FindingBindingV1 = z.infer<typeof FindingBindingV1Schema>;

export function parseFrictionAnalysisFindingInputs(input: unknown): readonly FrictionAnalysisFindingInputV1[] {
  const findings = z.array(FrictionAnalysisFindingInputV1Schema).min(1).parse(input);
  const candidateRefs = new Set<string>();
  const findingKeys = new Set<string>();
  for (const finding of findings) {
    if (candidateRefs.has(finding.candidateRef)) {
      throw new Error(`duplicate candidateRef: ${finding.candidateRef}`);
    }
    if (findingKeys.has(finding.findingKey)) {
      throw new Error(`duplicate findingKey: ${finding.findingKey}`);
    }
    candidateRefs.add(finding.candidateRef);
    findingKeys.add(finding.findingKey);
  }
  return deepFreeze(findings);
}

export function buildFrictionAnalysisFinding(input: {
  parentVerdictId: string;
  judgment: FrictionAnalysisFindingInputV1;
  repairTargetResolution: FrictionRepairTargetResolution;
}): FrictionAnalysisFindingV1 {
  const { repairTargetHint: _serverOnlyHint, ...judgment } = input.judgment;
  return deepFreeze(
    FrictionAnalysisFindingV1Schema.parse({
      schemaVersion: 1,
      parentVerdictId: input.parentVerdictId,
      domainId: 'eval:friction',
      ...judgment,
      repairTargetResolution: input.repairTargetResolution,
    }),
  );
}

export function serializeFrictionAnalysisFinding(finding: FrictionAnalysisFindingV1): string {
  const parsed = FrictionAnalysisFindingV1Schema.parse(finding);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function digestFrictionAnalysisFinding(finding: FrictionAnalysisFindingV1): string {
  return createHash('sha256').update(serializeFrictionAnalysisFinding(finding), 'utf8').digest('hex');
}

export function deriveFrictionChildVerdictId(parentVerdictId: string, findingKey: string): string {
  const digest = createHash('sha256')
    .update(`${parentVerdictId}\u001f${findingKey}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  const parent = parentVerdictId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  const key = findingKey
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${parent || 'friction'}-finding-${key || 'finding'}-${digest}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
