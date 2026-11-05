import type { CollectiveModificationProjection } from '@cat-cafe/shared';

const labels = {
  requested: '已请求修改',
  running: '修改中',
  proposal_ready: '修改已返回',
  cancelled: '已取消',
  accepted: '已采用并写回',
  conflict: '版本已改变',
  unavailable: '暂时无法继续',
};

export function sharedArtifactRequestState(request: CollectiveModificationProjection) {
  return request.resolution?.kind === 'rejected' ? '未采用' : labels[request.state];
}
