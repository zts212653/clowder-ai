import { z } from 'zod';
import { bounded } from './capability-evolution-refs.js';

/**
 * Owner-supplied review copy for one F266 repair decision. These words are
 * published with the immutable finding artifact; F246/F311 only project them.
 */
export const evalRepairDecisionExplanationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    expectedChange: bounded(4_000),
    beforeSummary: bounded(4_000),
    afterSummary: bounded(4_000),
    changeSetSummary: bounded(4_000),
    attributionBoundary: bounded(4_000),
    independentVerification: bounded(4_000),
    rejectedCandidates: z.array(bounded(1_000)).min(1).max(16),
    costAndRollback: bounded(4_000),
  })
  .strict();

export type EvalRepairDecisionExplanationV1 = z.infer<typeof evalRepairDecisionExplanationV1Schema>;
