import type { CatRoutingError } from '@cat-cafe/shared';
import { replyLayersCopy } from './reply-layers/reply-layers.shell-copy';
import { useShellCopy } from './shell/shell-copy';

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
    case 'handoff_blocked_by_failed_turn':
      return `回合失败，正文中的接棒请求未发送给 ${warning.targetCats.map((catId) => `@${catId}`).join('、')}。若尚未交接，可引用这条回复并 @ 接棒成员。`;
    case 'cat_not_found':
      return `${warning.mention} 不存在，已跳过。`;
  }

  const exhaustive: never = warning;
  return exhaustive;
}

export function FailedHandoffNotice({ warnings }: { warnings?: readonly CatRoutingError[] }) {
  const t = useShellCopy(replyLayersCopy);
  const warning = warnings?.find((candidate) => candidate.kind === 'handoff_blocked_by_failed_turn');
  if (!warning) return null;
  return (
    <output data-testid="failed-handoff-notice" className="mt-1 block break-words text-xs text-cafe-muted">
      {t.handoff.unsent(warning.targetCats.map((catId) => `@${catId}`).join(', '))}
    </output>
  );
}

export function RoutingWarningNotice({
  warnings,
  replyV2 = false,
}: {
  warnings?: readonly CatRoutingError[];
  replyV2?: boolean;
}) {
  if (!warnings?.length) return null;
  const remaining = replyV2
    ? warnings.filter((warning) => warning.kind !== 'handoff_blocked_by_failed_turn')
    : warnings;
  if (!remaining.length) return null;

  return (
    <div
      role="status"
      data-testid="routing-warning"
      className="mt-1.5 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-2 py-1.5 text-xs text-conn-amber-text"
    >
      {remaining.map(formatRoutingWarning).join(' ')}
    </div>
  );
}
