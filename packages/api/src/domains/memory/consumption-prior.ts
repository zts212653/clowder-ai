// F200 Phase C: Bayesian shrinkage CTR with three-branch constitutional immunity

import type { F163Authority } from './f163-types.js';

export interface ConsumptionPriorInput {
  consumedCount30d: number;
  exposureCount30d: number;
  daysSinceLastConsumed: number | null;
  docKind: string;
  authority: F163Authority;
  firstIndexedAt: number;
}

export interface ConsumptionPriorResult {
  shrunkCtr: number;
  meanCtrKind: number;
  recencyFactor: number;
  rawLift: number;
  prior: number;
  branch: 'constitutional' | 'cold-start' | 'low-sample' | 'full';
}

const ALPHA_0 = 2;
const BETA_0 = 8;
const GRACE_PERIOD_MS = 14 * 86_400_000;

const KIND_HALF_LIVES: Record<string, number | null> = {
  adr: null,
  lesson: null,
  canon: null,
  feature: 90,
  decision: 90,
  plan: 45,
  research: 45,
  phase: 45,
  discussion: 21,
  reflection: 21,
  thread: 14,
  session: 14,
};

export { KIND_HALF_LIVES };

export function computeConsumptionPrior(
  input: ConsumptionPriorInput,
  globalMeanCtr: Record<string, number>,
): ConsumptionPriorResult {
  if (input.firstIndexedAt > 0 && Date.now() - input.firstIndexedAt < GRACE_PERIOD_MS) {
    return { shrunkCtr: 0, meanCtrKind: 0, recencyFactor: 0, rawLift: 0, prior: 0, branch: 'cold-start' };
  }

  const shrunkCtr = (input.consumedCount30d + ALPHA_0) / (input.exposureCount30d + ALPHA_0 + BETA_0);
  const meanCtrKind = globalMeanCtr[input.docKind] ?? 0.2;
  const halfLife = input.docKind in KIND_HALF_LIVES ? KIND_HALF_LIVES[input.docKind] : 45;
  const recencyFactor =
    input.daysSinceLastConsumed == null
      ? 0.5
      : halfLife == null
        ? 1.0
        : halfLife / (halfLife + input.daysSinceLastConsumed);
  const rawLift = (shrunkCtr - meanCtrKind) * recencyFactor;

  const isConstitutional = input.authority === 'constitutional' || ['decision', 'lesson'].includes(input.docKind);

  if (isConstitutional) {
    return { shrunkCtr, meanCtrKind, recencyFactor, rawLift, prior: Math.max(0, rawLift), branch: 'constitutional' };
  }
  if (input.exposureCount30d < 5) {
    return { shrunkCtr, meanCtrKind, recencyFactor, rawLift, prior: 0, branch: 'cold-start' };
  }
  if (input.exposureCount30d < 20) {
    return { shrunkCtr, meanCtrKind, recencyFactor, rawLift, prior: Math.max(0, rawLift), branch: 'low-sample' };
  }
  return { shrunkCtr, meanCtrKind, recencyFactor, rawLift, prior: rawLift, branch: 'full' };
}
