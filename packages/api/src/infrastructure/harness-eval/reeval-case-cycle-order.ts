export interface ReevalCycleOrderKey {
  verdictId: string;
  createdAt: string;
}

export function compareReevalCycles(left: ReevalCycleOrderKey, right: ReevalCycleOrderKey): number {
  const timeOrder = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return timeOrder || left.verdictId.localeCompare(right.verdictId);
}

export function isLaterReevalCycle(candidate: ReevalCycleOrderKey, baseline: ReevalCycleOrderKey): boolean {
  return compareReevalCycles(candidate, baseline) > 0;
}
