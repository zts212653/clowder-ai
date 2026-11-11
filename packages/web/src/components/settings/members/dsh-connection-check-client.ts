import type { DshConnectionCheckView } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

export async function readDshConnectionCheck(catId: string): Promise<DshConnectionCheckView> {
  return apiFetch(`/api/cats/${encodeURIComponent(catId)}/connection-check`)
    .then(async (response) =>
      response.ok ? response.json() : { state: 'unknown', reasonCode: 'check_result_unknown' },
    )
    .catch(() => ({ state: 'unknown', reasonCode: 'check_result_unknown' }));
}

/** A model request is sent only by the explicit diagnostic action. */
export async function checkSavedDshMember(
  member: Pick<CatData, 'id' | 'configurationRevision'>,
): Promise<DshConnectionCheckView> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const attemptId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return apiFetch(
    `/api/cats/${encodeURIComponent(member.id)}/connection-check`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attemptId,
        ...(member.configurationRevision ? { expectedRevision: member.configurationRevision } : {}),
      }),
    },
    { mutationTimeoutMs: 100_000 },
  )
    .then(async (response) =>
      response.ok ? response.json() : { state: 'unknown', reasonCode: 'check_result_unknown' },
    )
    .catch(() => ({ state: 'unknown', reasonCode: 'check_result_unknown' }));
}

export function dshConnectionCheckMessage(view: DshConnectionCheckView) {
  const toolIssues = view.toolIssues ?? (view.state === 'passed' ? view.fact?.toolIssues : undefined) ?? [];
  const plugins = [...new Set(toolIssues.map(({ pluginId }) => pluginId))].join('、');
  const toolNotice = plugins
    ? `插件工具暂不可用：${plugins}（工具定义无效）。需要这些工具的任务请先修复相应插件。`
    : '';
  if (view.state === 'passed' && toolNotice) return `模型已连接，基本聊天可用。${toolNotice}`;
  if (view.state === 'passed') return '已收到所选模型的回复，工具定义已被接受。此检查不执行工具。';
  if (view.state === 'checking') return `正在检查连接，可以继续聊天，无需等待检查完成。${toolNotice}`;
  if (view.state === 'stale')
    return `配置或工具定义已变化，先前检查仅供历史参考。可重新检查，也可直接聊天。${toolNotice}`;
  if (view.state === 'unchecked') return `尚未运行独立连接检查，可以直接聊天。${toolNotice}`;
  const reasons: Record<string, string> = {
    tool_schema_rejected: '工具配置被模型拒绝，暂时无法回复。请更新出错插件；无需重新添加成员。',
    dsh_setup_auth_refresh_required: 'Desktop 登录需要更新。请先在 DSH Desktop 重新登录，再重试检查。',
    dsh_setup_credential_missing: 'Desktop 未提供所选路线的认证。请在 Desktop 配置该路线后重试。',
    dsh_setup_credential_invalid: '无法读取 Desktop 认证文件。请先在 Desktop 修复认证，再重试。',
    dsh_setup_custom_startup: '此启动配置无法自动检查。请检查 Desktop 安装和模型配置，或直接聊天查看结果。',
    session_configuration_unavailable:
      '客户端未能采用所选模型或思考强度，尚未发送模型检查请求。请检查所选模型设置后重试。',
    check_timed_out: '连接检查超时，无法确认模型回复。检查进程已关闭；可重试或直接聊天。',
    check_store_unavailable: '检查记录服务暂不可用，尚未发送模型检查请求。稍后刷新状态再试。',
    model_reply_unconfirmed: '检查已结束，但未确认正常的文本回复。可重试或直接聊天查看结果。',
  };
  return `成员与配置已保留。${reasons[view.reasonCode ?? ''] ?? '未能确认本次连接结果，原因尚不明确。请在成员设置中查看检查详情、刷新状态；不会自动重发模型请求。'}${toolNotice}`;
}
