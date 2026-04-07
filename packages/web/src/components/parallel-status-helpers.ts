/** Derive the full set of active cats from targetCats (socket-driven) + activeInvocations (slot-aware). */
export function deriveActiveCats(
  targetCats: string[],
  activeInvocations?: Record<string, { catId: string; mode: string; startedAt?: number }> | null,
): string[] {
  const seen = new Set(targetCats);
  const result = [...targetCats];
  if (!activeInvocations) return result;
  for (const slot of Object.values(activeInvocations)) {
    if (!seen.has(slot.catId)) {
      seen.add(slot.catId);
      result.push(slot.catId);
    }
  }
  return result;
}
