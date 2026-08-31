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
    case 'mention_ambiguous': {
      const candidates = warning.candidates
        .slice(0, 3)
        .map((candidate) => candidate.mention)
        .join('、');
      return `${warning.mention} 同时指向多个成员${candidates ? `（${candidates}）` : ''}，请改用唯一 handle。`;
    }
    case 'suppressed_by_terminal_ack':
      return `${warning.droppedMentions.map((catId) => `@${catId}`).join('、')} 已有 terminal ACK，未触发新回复。`;
    case 'cat_not_found':
      return `${warning.mention} 不存在，已跳过。`;
  }

  const exhaustive: never = warning;
  return exhaustive;
}

export function RoutingWarningNotice({ warnings }: { warnings?: readonly CatRoutingError[] }) {
  if (!warnings?.length) return null;

  return (
    <div
      role="status"
      data-testid="routing-warning"
      className="mt-1.5 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-2 py-1.5 text-xs text-conn-amber-text"
    >
      {warnings.map(formatRoutingWarning).join(' ')}
    </div>
  );
}
