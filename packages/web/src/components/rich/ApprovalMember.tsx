import { ShellCatAvatar } from '@/components/shell/ShellCatAvatar';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { approvalMemberCopy } from './approval-member.shell-copy';

/** Readable decision participants from the same registry as Chat; an unknown address is not a name. */
export function ApprovalMember({ catId, showModel = true }: { catId: string; showModel?: boolean }) {
  const { getCatById } = useCatData({ fetch: false });
  const t = useShellCopy(approvalMemberCopy);
  const cat = getCatById(catId);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <ShellCatAvatar catId={catId} size={20} />
      <span className="min-w-0 break-words">
        {cat ? cat.nickname?.trim() || cat.displayName : t.unavailable}
        {showModel && cat?.defaultModel ? (
          <span className="text-[var(--shell-muted)]"> · {cat.defaultModel}</span>
        ) : null}
      </span>
    </span>
  );
}
