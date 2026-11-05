import { useEffect, useMemo } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { projectSidebarRows, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { refreshSidebarThreadSnapshot } from '@/utils/sidebar-thread-snapshot';
import { EditField } from './ProposalCardFields';
import { proposalCardCopy } from './proposal-card.shell-copy';

/** Select real conversation names; the original exact-address override remains an explicit advanced field. */
export function ProposalParentField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useShellCopy(proposalCardCopy);
  const rows = useSidebarProjectionStore((s) => s.rows);
  const pendingThreadCommands = useSidebarProjectionStore((s) => s.pendingThreadCommands);
  const threads = useMemo(() => projectSidebarRows({ rows, pendingThreadCommands }), [rows, pendingThreadCommands]);
  useEffect(() => {
    // The narrow shell need not mount a sidebar. Reuse its authorized, coordinated reader, not a second list store.
    void refreshSidebarThreadSnapshot();
  }, []);
  const { currentThread } = useThreadDisplayInfo(value);
  const alternatives = threads.filter((thread) => thread.id !== value);
  return (
    <div className="space-y-1">
      <label className="block text-[var(--shell-muted)]">
        {t.parentEdit}
        <select
          aria-label={t.parentEdit}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded border border-[var(--shell-hairline)] bg-[var(--shell-paper)] p-1 text-xs"
        >
          <option value={value}>{currentThread?.title || t.parentUnavailable}</option>
          {alternatives.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title || t.untitled}
            </option>
          ))}
        </select>
      </label>
      <details className="text-xs text-[var(--shell-muted)]">
        <summary className="shell-focusable cursor-pointer">{t.technical}</summary>
        <EditField label={t.parentAddress} value={value} onChange={onChange} />
      </details>
    </div>
  );
}
