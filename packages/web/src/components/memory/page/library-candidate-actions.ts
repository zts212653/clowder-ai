import { apiFetch } from '@/utils/api-client';

type ActionResult =
  | { kind: 'confirm' }
  | { kind: 'blocked'; message: string }
  | { kind: 'done'; status: 'approved' | 'rejected'; materialized: { outputPath: string; reindexed: boolean } | null };
export async function writeLibraryCandidate(
  action: 'approve' | 'reject',
  markerId: string,
  target: { id: string; name: string } | undefined,
  confirmed: boolean,
): Promise<ActionResult> {
  const response = await apiFetch(`/api/knowledge/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markerId,
      ...(action === 'approve' && {
        targetCollectionId: target?.id,
        ...(confirmed && { confirmVisibilityWidening: true }),
      }),
    }),
  });
  const data: unknown = await response.json();
  const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (!response.ok) {
    if (
      action === 'approve' &&
      response.status === 400 &&
      payload.error === 'visibility-widening requires confirmation'
    )
      return { kind: 'confirm' };
    if (typeof payload.error === 'string' && payload.error.startsWith('visibility-widening blocked:'))
      return { kind: 'blocked', message: payload.error };
    throw new Error('Write unavailable');
  }
  if (payload.status !== (action === 'approve' ? 'approved' : 'rejected')) throw new Error('Invalid write response');
  const materialized = payload.materialized;
  return {
    kind: 'done',
    status: action === 'approve' ? 'approved' : 'rejected',
    materialized:
      materialized &&
      typeof materialized === 'object' &&
      'outputPath' in materialized &&
      typeof materialized.outputPath === 'string'
        ? {
            outputPath: materialized.outputPath,
            reindexed: 'reindexed' in materialized && materialized.reindexed === true,
          }
        : null,
  };
}
