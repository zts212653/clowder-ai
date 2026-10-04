const failureMessages: Record<string, string> = {
  target_denied: '这只猫当前不能接收请求。已保留你的选择和修改说明。',
  target_unavailable: '这只猫当前没有可用的修改返回入口。请重新核对具名目标。',
  thread_unavailable: '执行对话目前不可访问，请选择一个可访问的对话。',
  source_changed: '作品已有变化，请核对版本后再提交。原来的草稿仍保留。',
  asset_changed: '作品已有变化，请核对版本后再提交。原来的草稿仍保留。',
  revision_conflict: '讨论已有新内容，请刷新核对。修改说明仍保留。',
  operation_reused: '这个操作编号已经用于原来的请求；不能拿它提交不同内容。',
  needs_clarification: '请求里的时间还不明确，请补充明确日期后再提交。',
  attempt_timed_out: '本次准备超时，请求和草稿已保存，可以重试原操作。',
  access_denied: '当前无法访问原作品；已停止展示其缓存内容。',
  not_found: '找不到对应的作品或请求，它可能已被删除。',
  request_cancelled: '这次修改请求已取消。候选和历史仍保留，不能接受新的写回。',
  candidate_rejected: '此候选已拒绝；候选和讨论仍保留，不能再接受这个候选。',
  acceptance_exists: '此候选已有接受决定，请先核对原写回回执。',
  task_cancellation_pending: '原委托正在取消；请核对其实际状态后再发起新的修改。',
};
export function modificationFailureMessage(code: string): string {
  return failureMessages[code] ?? '暂时无法确认操作结果。请保留原操作并重试。';
}
export class ModificationHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(modificationFailureMessage(code));
  }
}
/** Routes send either `{ error: code }` or `{ error: { code } }`; anything else stays `unknown`. */
function failureCode(data: unknown): string {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === 'string') return error;
  const nested = (error as { code?: unknown } | null | undefined)?.code;
  return typeof nested === 'string' ? nested : 'unknown';
}
export async function checked<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ModificationHttpError(failureCode(await response.json().catch(() => null)), response.status);
  }
  return response.json() as Promise<T>;
}
export const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
