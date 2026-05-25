import { z } from 'zod';

const stringRefArray = z.array(z.string().min(1));
const nonEmptyStringArray = stringRefArray.min(1);
const isoDateTime = z.string().datetime({ offset: true });

const verdictHandoffPacketSchema = z
  .object({
    id: z.string().min(1),
    domainId: z.enum(['eval:a2a', 'eval:memory']),
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
    if (packet.verdict !== 'delete_sunset') return;
    if (packet.governance?.cvoAcceptRequired !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'delete_sunset verdict requires structured CVO accept gate',
        path: ['governance', 'cvoAcceptRequired'],
      });
    }
  });

export type VerdictHandoffPacket = z.infer<typeof verdictHandoffPacketSchema>;

export interface HandoffDecision {
  ok: boolean;
  reason?: string;
}

export function parseVerdictHandoffPacket(input: unknown): VerdictHandoffPacket {
  return verdictHandoffPacketSchema.parse(input);
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
