/** Derive the full set of active cats from targetCats (socket-driven) + activeInvocations (slot-aware). */
export function deriveActiveCats(
  targetCats: string[],
  activeInvocations?: Record<string, { catId: string; mode: string; startedAt?: number }> | null,
  catStatuses?: Record<string, string> | null,
): string[] {
  // targetCats is the round roster, not authoritative liveness. Once a cat has
  // reached 'done', keeping it in the "current" bar causes ghost counts until
  // the final clearCatStatuses() sweep runs. Keep pending / running / warning /
  // error cats, but drop already-completed ones unless a live slot still exists.
  const rosterCats = targetCats.filter((catId) => catStatuses?.[catId] !== 'done');
  const seen = new Set(rosterCats);
  const result = [...rosterCats];
  if (!activeInvocations) return result;
  for (const slot of Object.values(activeInvocations)) {
    if (!seen.has(slot.catId)) {
      seen.add(slot.catId);
      result.push(slot.catId);
    }
  }
  return result;
}
