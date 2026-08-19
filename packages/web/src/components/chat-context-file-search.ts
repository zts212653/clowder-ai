import { apiFetch } from '@/utils/api-client';

export interface ContextFileHit {
  path: string;
}

export async function searchWorkspaceContextFiles(
  worktreeId: string,
  query: string,
  signal: AbortSignal,
): Promise<ContextFileHit[]> {
  try {
    const response = await apiFetch('/api/workspace/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreeId, query, type: 'filename', limit: 8 }),
      signal,
    });
    if (!response.ok || signal.aborted) return [];
    const data = (await response.json()) as { results?: ContextFileHit[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}
