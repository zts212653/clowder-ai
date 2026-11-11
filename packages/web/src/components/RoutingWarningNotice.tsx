import type { CatRoutingError } from '@cat-cafe/shared';

function formatRoutingWarning(warning: CatRoutingError): string {
  switch (warning.kind) {
    case 'cat_disabled': {
      const alternatives = warning.alternatives
        .slice(0, 2)
        .map((alternative) => alternative.mention)
        .join('、');
      return `@${warning.catId} 已停用，已跳过${alternatives ? `；可用替代：${alternatives}` : ''}。`;
    }
    case 'target_not_in_thread':
      return `@${warning.catId} 不在当前 thread 的参与者列表中，已跳过。`;
    case 'suppressed_by_terminal_ack':
      return `${warning.droppedMentions.map((catId) => `@${catId}`).join('、')} 已有 terminal ACK，未触发新回复。`;
    case 'cat_not_found':
      return `${warning.mention} 不存在，已跳过。`;
    case 'unknown_mention_handle': {
      const alternatives = warning.alternatives.map(({ mention }) => mention).join('、');
      return `${warning.mention} 未识别，未投递${alternatives ? `；可用句柄：${alternatives}` : ''}。`;
    }
    case 'handoff_blocked_by_failed_turn':
      return `本轮异常结束，正文给 ${warning.catIds.map((catId) => `@${catId}`).join('、')} 的交接未提交。确认此前没有单独送达后，可引用这条回复并选择接棒成员。`;
    case 'parallel_handoff':
      return `这条回复指定了多个并行接棒成员。若工作有先后依赖，请每轮只 @ 下一棒。`;
  }

  const exhaustive: never = warning;
  return exhaustive;
}

export function RoutingWarningNotice({
  warnings,
  onReply,
}: {
  warnings?: readonly CatRoutingError[];
  onReply?: () => void;
}) {
  if (!warnings?.length) return null;

  return (
    <div
      role="status"
      data-testid="routing-warning"
      className="mt-1.5 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-2 py-1.5 text-xs text-conn-amber-text"
    >
      {warnings.map(formatRoutingWarning).join(' ')}
      {onReply &&
      warnings.some(({ kind }) => kind === 'handoff_blocked_by_failed_turn' || kind === 'unknown_mention_handle') ? (
        <button type="button" className="ml-2 underline" onClick={onReply}>
          引用这条回复
        </button>
      ) : null}
    </div>
  );
}
