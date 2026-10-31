import type { CatInvocationInfo, CatStatusType } from './chat-types';

export type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;

export interface TerminalActiveInvocationSlot {
  slotId: string;
  catId: string;
  status: CatStatusType;
}

export interface TerminalActiveInvocationProjection {
  activeInvocations: ActiveInvocationSlots;
  terminalSlots: TerminalActiveInvocationSlot[];
}

function terminalLifecycleStatus(info: CatInvocationInfo | undefined): CatStatusType | null {
  switch (info?.appServerLifecycle?.stage) {
    case 'failed':
      return 'error';
    case 'completed':
    case 'interrupted':
    case 'closing':
    case 'closed':
      return 'done';
    default:
      return null;
  }
}

function slotMatchesInvocation(slotId: string, catId: string, invocationId: string | undefined): boolean {
  if (!invocationId) return false;
  if (slotId === invocationId) return true;
  return slotId === `${invocationId}-${catId}`;
}

/**
 * Identify stale active slots that are proven terminal by the same invocation
 * identity. Both event writers and render projections use this proof so a
 * newer uncorrelated slot can never be removed by an older lifecycle record.
 */
export function findTerminalActiveInvocationSlots(
  activeInvocations: ActiveInvocationSlots,
  catInvocations: Record<string, CatInvocationInfo>,
): TerminalActiveInvocationSlot[] {
  const terminalSlots: TerminalActiveInvocationSlot[] = [];
  for (const [slotId, slot] of Object.entries(activeInvocations)) {
    const info = catInvocations[slot.catId];
    const status = terminalLifecycleStatus(info);
    if (!status) continue;
    if (!slotMatchesInvocation(slotId, slot.catId, info?.invocationId)) continue;
    terminalSlots.push({ slotId, catId: slot.catId, status });
  }
  return terminalSlots;
}

export function projectTerminalActiveInvocationSlots(
  activeInvocations: ActiveInvocationSlots,
  catInvocations: Record<string, CatInvocationInfo>,
): TerminalActiveInvocationProjection {
  const terminalSlots = findTerminalActiveInvocationSlots(activeInvocations, catInvocations);
  if (terminalSlots.length === 0) return { activeInvocations, terminalSlots };

  const terminalSlotIds = new Set(terminalSlots.map(({ slotId }) => slotId));
  return {
    activeInvocations: Object.fromEntries(
      Object.entries(activeInvocations).filter(([slotId]) => !terminalSlotIds.has(slotId)),
    ),
    terminalSlots,
  };
}
