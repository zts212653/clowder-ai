import type { BootstrapReport, GovernanceHealthSummary, GovernanceSelection } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

export type Operation = 'install' | 'cleanup';

function operationEndpoint(operation: Operation): string {
  return operation === 'install' ? '/api/governance/confirm' : '/api/governance/cleanup';
}

export async function postGovernanceOperation(
  projectPath: string,
  operation: Operation,
  dryRun: boolean,
  selection: GovernanceSelection,
  preview: BootstrapReport | null,
): Promise<{ report: BootstrapReport; conflict: boolean }> {
  const res = await apiFetch(operationEndpoint(operation), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath,
      dryRun,
      ...(operation === 'install' ? { selection } : {}),
      ...(!dryRun && preview ? { expectedPreviewChecksum: preview.previewChecksum } : {}),
    }),
  });
  const data = (await res.json()) as { report?: BootstrapReport; error?: string };
  if (!data.report) throw new Error(data.error ?? '治理操作没有返回预览');
  if (!res.ok && res.status !== 409) throw new Error(data.error ?? '治理操作失败');
  return { report: data.report, conflict: res.status === 409 };
}

function unsyncedSummary(projectPath: string): GovernanceHealthSummary {
  return { projectPath, status: 'never-synced', packVersion: null, lastSyncedAt: null, findings: [] };
}

export async function discoverUnsynced(known: readonly GovernanceHealthSummary[]): Promise<GovernanceHealthSummary[]> {
  try {
    const threadsRes = await apiFetch('/api/threads');
    if (!threadsRes.ok) return [...known];
    const { threads } = (await threadsRes.json()) as { threads: { projectPath?: string }[] };
    const projectPaths = [
      ...new Set(
        threads.flatMap((thread) =>
          thread.projectPath && thread.projectPath !== 'default' ? [thread.projectPath] : [],
        ),
      ),
    ];
    if (projectPaths.length === 0) return [...known];
    const discoverRes = await apiFetch('/api/governance/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPaths }),
    });
    if (!discoverRes.ok) return [...known];
    const { unsynced } = (await discoverRes.json()) as { unsynced: string[] };
    const knownPaths = new Set(known.map((project) => project.projectPath));
    return [...known, ...unsynced.filter((path) => !knownPaths.has(path)).map(unsyncedSummary)];
  } catch {
    return [...known];
  }
}
