import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useShellCopy } from '../shell-copy';
import type { ReconcileState } from './approval-reconcile';
import { approvalReconcileCopy } from './approval-reconcile.shell-copy';

export function ApprovalResultLink({ state }: { state: ReconcileState }) {
  const t = useShellCopy(approvalReconcileCopy);
  if (state.kind !== 'decided' || state.terminal.resolution !== 'accepted' || !state.terminal.threadId) return null;
  const threadId = state.terminal.threadId;
  return (
    <button
      type="button"
      data-testid="mailbox-result-open"
      className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
      style={{ color: 'var(--shell-primary-text)' }}
      onClick={() => pushThreadRouteWithHistory(threadId, window)}
    >
      {t.open}
    </button>
  );
}
