import {
  EXPANSION_HEALTH_SOURCE_REVISION,
  type ExpansionFunnelMeta,
  type ExpansionHealthGateReason,
} from '@cat-cafe/shared';
import type { ExpansionFunnel, ExpansionHint } from './TopkExpansionService.js';

const EMPTY_KEYWORD = Object.freeze({ probed: 0, added: 0, deduped: 0 });
const EMPTY_CONVENTION = Object.freeze({ attempted: false, added: 0, deduped: 0, staleSkipped: 0 });

function base(): Pick<ExpansionFunnelMeta, 'schemaVersion' | 'cohort' | 'sourceRevision'> {
  return {
    schemaVersion: 1,
    cohort: 'natural_topk',
    sourceRevision: EXPANSION_HEALTH_SOURCE_REVISION,
  };
}

const FOLLOWUP_WINDOW = Object.freeze({ maxToolDistance: 20 as const, maxWallClockMs: 300_000 as const });

export function blockedExpansionHealth(
  gateReason: Exclude<ExpansionHealthGateReason, 'eligible' | 'expansion_error'>,
): ExpansionFunnelMeta {
  return {
    ...base(),
    eligible: false,
    gateReason,
    followupWindow: { ...FOLLOWUP_WINDOW },
    attempted: false,
    keyword: { ...EMPTY_KEYWORD },
    sourceThread: { ...EMPTY_KEYWORD },
    conventionEdge: { ...EMPTY_CONVENTION },
    presented: 0,
    hints: [],
  };
}

export function successfulExpansionHealth(
  funnel: ExpansionFunnel,
  hints: readonly ExpansionHint[],
): ExpansionFunnelMeta {
  return {
    ...base(),
    eligible: true,
    gateReason: 'eligible',
    followupWindow: { ...FOLLOWUP_WINDOW },
    attempted: true,
    keyword: funnel.keyword,
    sourceThread: funnel.sourceThread,
    conventionEdge: funnel.conventionEdge,
    presented: hints.length,
    hints: hints.map((hint) => ({
      anchor: hint.anchor,
      targetRef: hint.targetRef,
    })),
  };
}

export function failedExpansionHealth(): ExpansionFunnelMeta {
  return {
    ...base(),
    eligible: true,
    gateReason: 'expansion_error',
    followupWindow: { ...FOLLOWUP_WINDOW },
    attempted: true,
    keyword: { ...EMPTY_KEYWORD },
    sourceThread: { ...EMPTY_KEYWORD },
    conventionEdge: { ...EMPTY_CONVENTION },
    presented: 0,
    hints: [],
  };
}
