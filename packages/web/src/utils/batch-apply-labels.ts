export function filterSuggestions(
  raw: Record<string, unknown>,
  validThreadIds: Set<string>,
  validLabelIds: Set<string>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [tid, lids] of Object.entries(raw)) {
    if (!validThreadIds.has(tid) || !Array.isArray(lids)) continue;
    const filtered = (lids as string[]).filter((id) => validLabelIds.has(id));
    if (filtered.length > 0) map.set(tid, filtered);
  }
  return map;
}

export interface PendingLabelSpec {
  name: string;
  color: string;
}

export function extractPendingLabelSuggestions(
  raw: Record<string, unknown>,
  validThreadIds: Set<string>,
): { pendingLabels: PendingLabelSpec[]; nameAssignments: Map<string, string[]> } | null {
  const newLabels = raw.newLabels as { name: string; color: string }[] | undefined;
  const assignments = raw.assignments as Record<string, string[]> | undefined;
  if (!Array.isArray(newLabels) || !assignments) return null;

  const pendingLabels = newLabels.filter((s) => s.name && s.color);
  const validNames = new Set(pendingLabels.map((l) => l.name));
  const nameAssignments = new Map<string, string[]>();
  for (const [tid, names] of Object.entries(assignments)) {
    if (!validThreadIds.has(tid) || !Array.isArray(names)) continue;
    const filtered = (names as string[]).filter((n) => validNames.has(n));
    if (filtered.length > 0) nameAssignments.set(tid, filtered);
  }
  return { pendingLabels, nameAssignments };
}
