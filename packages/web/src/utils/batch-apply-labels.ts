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

type CreateLabelFn = (name: string, color: string) => Promise<{ id: string } | null>;

export async function createAndResolveLabels(
  pendingLabels: PendingLabelSpec[],
  nameAssignments: Map<string, string[]>,
  createLabel: CreateLabelFn,
): Promise<Map<string, string[]>> {
  const nameToId = new Map<string, string>();
  for (const spec of pendingLabels) {
    const label = await createLabel(spec.name, spec.color);
    if (label) nameToId.set(spec.name, label.id);
  }

  const map = new Map<string, string[]>();
  for (const [tid, names] of nameAssignments) {
    const ids = names.map((n) => nameToId.get(n)).filter((id): id is string => !!id);
    if (ids.length > 0) map.set(tid, ids);
  }
  return map;
}

export interface BatchApplyResult {
  failedThreadIds: string[];
}

type UpdateFn = (threadId: string, labelIds: string[]) => Promise<void>;

export async function batchApplyLabels(
  assignments: Map<string, string[]>,
  updateFn: UpdateFn,
): Promise<BatchApplyResult> {
  const entries = Array.from(assignments.entries());
  if (entries.length === 0) return { failedThreadIds: [] };

  const results = await Promise.allSettled(
    entries.map(([threadId, labelIds]) => updateFn(threadId, labelIds).then(() => threadId)),
  );

  const failedThreadIds: string[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      failedThreadIds.push(entries[i][0]);
    }
  }

  return { failedThreadIds };
}
