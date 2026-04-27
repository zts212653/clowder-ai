export interface RecentArtifact {
  type: 'pr' | 'file' | 'plan' | 'feature-doc';
  ref: string;
  label: string;
  updatedAt: number;
  updatedBy: string;
  ops?: string[];
}

const MAX_ARTIFACTS = 5;
const WRITE_OPS = new Set(['edit', 'create', 'delete']);

function classifyPath(path: string): RecentArtifact['type'] {
  if (path.startsWith('docs/features/')) return 'feature-doc';
  if (path.startsWith('docs/plans/')) return 'plan';
  return 'file';
}

function labelFromPath(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

export interface ArtifactExtractionInput {
  filesTouched: Array<{ path: string; ops: string[] }>;
  prTasks: Array<{
    id: string;
    kind: string;
    subjectKey: string | null;
    title: string;
    ownerCatId: string | null;
    status: string;
    updatedAt: number;
  }>;
  catId: string;
}

export function extractRecentArtifacts(input: ArtifactExtractionInput): RecentArtifact[] {
  const artifacts: RecentArtifact[] = [];

  for (const task of input.prTasks) {
    if (task.kind !== 'pr_tracking' || task.status === 'done' || !task.subjectKey) continue;
    const prRef = task.subjectKey.replace(/^pr:/, '');
    const prNumber = prRef.match(/#(\d+)/)?.[0] ?? prRef;
    artifacts.push({
      type: 'pr',
      ref: prRef,
      label: `PR ${prNumber}`,
      updatedAt: task.updatedAt,
      updatedBy: task.ownerCatId ?? 'unknown',
    });
  }

  for (const file of input.filesTouched) {
    if (!file.ops.some((op) => WRITE_OPS.has(op))) continue;
    artifacts.push({
      type: classifyPath(file.path),
      ref: file.path,
      label: labelFromPath(file.path),
      updatedAt: Date.now(),
      updatedBy: input.catId,
      ops: file.ops.filter((op) => WRITE_OPS.has(op)),
    });
  }

  return sortAndCapArtifacts(artifacts);
}

export function sortAndCapArtifacts(artifacts: RecentArtifact[], max = MAX_ARTIFACTS): RecentArtifact[] {
  return [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max);
}

const MAX_LEDGER_ENTRIES = 20;

export function mergeLedger(
  existing: readonly RecentArtifact[],
  incoming: readonly RecentArtifact[],
): RecentArtifact[] {
  const byRef = new Map<string, RecentArtifact>();
  for (const a of existing) byRef.set(a.ref, a);
  for (const a of incoming) {
    const prev = byRef.get(a.ref);
    if (!prev || a.updatedAt >= prev.updatedAt) byRef.set(a.ref, a);
  }
  return [...byRef.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LEDGER_ENTRIES);
}
