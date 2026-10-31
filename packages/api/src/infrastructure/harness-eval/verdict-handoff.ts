import { z } from 'zod';
import { evalDomainIdSchema } from './domain/eval-domain-registry.js';
import {
  type FindingBindingV1,
  FindingBindingV1Schema,
  type ResolvedRepairTargetV1,
  ResolvedRepairTargetV1Schema,
} from './friction/friction-finding-artifact.js';

const stringRefArray = z.array(z.string().min(1));
const nonEmptyStringArray = stringRefArray.min(1);
const isoDateTime = z.string().datetime({ offset: true });
const findingKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/, 'findingKey must be a stable lowercase domain-local slug');

const verdictHandoffPacketSchema = z
  .object({
    id: z.string().min(1),
    domainId: evalDomainIdSchema,
    findingKey: findingKeySchema.optional(),
    findingBinding: FindingBindingV1Schema.optional(),
    repairTarget: ResolvedRepairTargetV1Schema.optional(),
    createdAt: isoDateTime,
    phenomenon: z.string().min(1),
    harnessUnderEval: z.object({
      featureId: z.string().min(1),
      componentId: z.string().min(1),
      name: z.string().min(1),
    }),
    evidencePacket: z.object({
      snapshotRefs: stringRefArray,
      attributionRefs: stringRefArray,
      metricRefs: stringRefArray,
      sampleTraceRefs: stringRefArray,
    }),
    dailyTrend: z.object({
      window: z.string().min(1),
      current: z.record(z.number()),
      baseline: z.record(z.number()),
      threshold: z.record(z.number()),
      direction: z.enum(['improved', 'regressed', 'flat', 'unknown']),
    }),
    rootCauseHypothesis: z.object({
      summary: z.string().min(1),
      confidence: z.enum(['low', 'medium', 'high']),
      alternatives: nonEmptyStringArray,
    }),
    verdict: z.enum(['delete_sunset', 'build', 'fix', 'keep_observe']),
    ownerAsk: z.object({
      targetFeatureId: z.string().min(1),
      targetOwnerCatId: z.string().min(1),
      requestedAction: z.string().min(1),
    }),
    governance: z
      .object({
        cvoAcceptRequired: z.boolean(),
      })
      .optional(),
    acceptanceReevalPlan: z.object({
      nextEvalAt: isoDateTime,
      closureCondition: z.string().min(1),
    }),
    counterarguments: nonEmptyStringArray,
  })
  .superRefine((packet, ctx) => {
    if (packet.verdict === 'delete_sunset' && packet.governance?.cvoAcceptRequired !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'delete_sunset verdict requires structured operator accept gate',
        path: ['governance', 'cvoAcceptRequired'],
      });
    }
    const hasFrictionChildField = packet.findingBinding !== undefined || packet.repairTarget !== undefined;
    if (hasFrictionChildField && (!packet.findingKey || !packet.findingBinding || !packet.repairTarget)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'friction child packet requires findingKey, findingBinding, and repairTarget together',
        path: ['findingBinding'],
      });
    }
    if (packet.findingBinding || packet.repairTarget) {
      if (packet.domainId !== 'eval:friction') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'findingBinding and repairTarget are child-only eval:friction fields',
          path: ['domainId'],
        });
      }
      if (
        packet.repairTarget &&
        (packet.ownerAsk.targetFeatureId !== packet.repairTarget.featureId ||
          packet.ownerAsk.targetOwnerCatId !== packet.repairTarget.ownerCatId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ownerAsk must exact-match server-resolved repairTarget',
          path: ['repairTarget'],
        });
      }
    }
  });

export type VerdictHandoffPacket = z.infer<typeof verdictHandoffPacketSchema>;
export type FrictionVerdictHandoffPacketV3 = VerdictHandoffPacket & {
  findingKey: string;
  findingBinding: FindingBindingV1;
  repairTarget: ResolvedRepairTargetV1;
};

export interface HandoffDecision {
  ok: boolean;
  reason?: string;
}

export function parseVerdictHandoffPacket(input: unknown): VerdictHandoffPacket {
  return verdictHandoffPacketSchema.parse(input);
}

export function isFrictionVerdictHandoffPacketV3(
  packet: VerdictHandoffPacket,
): packet is FrictionVerdictHandoffPacketV3 {
  return Boolean(packet.findingKey && packet.findingBinding && packet.repairTarget);
}

export function assertCanCrossThreadHandoff(packet: VerdictHandoffPacket): HandoffDecision {
  const evidenceCounts = [
    packet.evidencePacket.snapshotRefs.length,
    packet.evidencePacket.attributionRefs.length,
    packet.evidencePacket.metricRefs.length,
    packet.evidencePacket.sampleTraceRefs.length,
  ];
  if (evidenceCounts.some((count) => count === 0)) {
    return { ok: false, reason: 'evidence packet must include snapshot, attribution, metric, and trace refs' };
  }

  return { ok: true };
}
