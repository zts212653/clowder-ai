import { apiFetch } from '@/utils/api-client';

type ActionResult = { kind: 'confirm' } | { kind: 'blocked'; message: string } | { kind: 'done'; message: string };
function collectedMessage(payload: Record<string, unknown>, targetName: string | undefined): string {
  const result = payload.materialized;
  if (!result || typeof result !== 'object' || !('outputPath' in result) || typeof result.outputPath !== 'string')
    return '已批准 · 收录结果暂时读不到';
  return 'reindexed' in result && result.reindexed === true ? `已收录到 ${targetName}` : '已写入文档，索引稍后更新';
}
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
      return { kind: 'blocked', message: '来源可见范围无法确认，暂不能收录。' };
    throw new Error('Write unavailable');
  }
  if (payload.status !== (action === 'approve' ? 'approved' : 'rejected')) throw new Error('Invalid write response');
  return { kind: 'done', message: action === 'reject' ? '已选择不收录' : collectedMessage(payload, target?.name) };
}
