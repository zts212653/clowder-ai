import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import type { PreparedArtifactCoordinate } from './PreparedArtifactPreview';
import { preparedArtifactThreadId, resolvePreparedArtifact } from './resolve-prepared-artifact';

/** Read the original F232 owner and retain exact thread/ref/revision matching. */
export async function readPreparedArtifact(coordinate: PreparedArtifactCoordinate, signal: AbortSignal) {
  const threadId = preparedArtifactThreadId(coordinate);
  if (!threadId) return undefined;
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/artifacts`, { signal });
  if (!response.ok) throw new Error(`Artifact owner read failed: ${response.status}`);
  const body = (await response.json()) as { threadId?: string; artifacts?: ThreadArtifactDTO[] };
  if (body.threadId !== threadId || !Array.isArray(body.artifacts)) return undefined;
  return resolvePreparedArtifact(
    body.artifacts.map((artifact) => ({ ...artifact, threadId })),
    coordinate,
  );
}
