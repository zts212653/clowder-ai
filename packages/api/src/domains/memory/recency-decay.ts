// F200 Phase C: Fractional decay T/(T+age) per doc kind

import { KIND_HALF_LIVES } from './consumption-prior.js';

export interface DecayResult {
  factor: number;
  halfLife: number | null;
}

export function computeRecencyDecay(ageDays: number, docKind: string): DecayResult {
  const halfLife = docKind in KIND_HALF_LIVES ? KIND_HALF_LIVES[docKind] : 45;
  if (halfLife == null) return { factor: 1.0, halfLife: null };
  return { factor: halfLife / (halfLife + ageDays), halfLife };
}
