import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { useShellCopy } from '../shell-copy';
import { originalApprovalCopy } from './original-approval.shell-copy';

export function OriginalApprovalOrigin({ threadId }: { threadId: string }) {
  const t = useShellCopy(originalApprovalCopy);
  const { currentThread } = useThreadDisplayInfo(threadId);
  return (
    <p className="mb-2 text-xs text-[var(--shell-muted)]">
      {t.sourceConversation}: {currentThread?.title || t.sourceUnavailable}
    </p>
  );
}
