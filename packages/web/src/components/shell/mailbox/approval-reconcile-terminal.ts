import type { Terminal } from './approval-reconcile';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TERMINAL_RESOLUTIONS: readonly Terminal['resolution'][] = ['accepted', 'rejected', 'closed_without_decision'];

/** A terminal, from a settled row, or null when the row does not say one of the three; the time and decider only if real. */
export function readTerminal(value: unknown): Terminal | null {
  if (!isRecord(value)) return null;
  const resolution = TERMINAL_RESOLUTIONS.find((candidate) => candidate === value.resolution);
  if (!resolution) return null;
  const decidedBy = typeof value.decidedBy === 'string' ? value.decidedBy.trim() : '';
  return {
    resolution,
    ...(resolution === 'closed_without_decision' &&
    (value.closedReason === 'expired' || value.closedReason === 'withdrawn')
      ? { closedReason: value.closedReason }
      : {}),
    ...(typeof value.decidedAt === 'number' && Number.isFinite(value.decidedAt) ? { decidedAt: value.decidedAt } : {}),
    ...(decidedBy ? { decidedBy } : {}),
    ...(resolution === 'accepted' && typeof value.threadId === 'string' && value.threadId.trim()
      ? { threadId: value.threadId }
      : {}),
    ...(resolution === 'accepted' && value.effectUnknown === true ? { effectUnknown: true } : {}),
    ...(resolution === 'accepted' &&
    (value.domainEffect === 'dispatch-delivered' ||
      value.domainEffect === 'entity-written' ||
      value.domainEffect === 'taste-written')
      ? { domainEffect: value.domainEffect }
      : {}),
  };
}
