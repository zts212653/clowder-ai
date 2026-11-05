import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { groupTitle } from './search-group-types';

interface Props {
  visibleCandidates: readonly SidebarSnapshotRow[];
  candidates: readonly SidebarSnapshotRow[];
  selectedOutsideSearch: readonly SidebarSnapshotRow[];
  groupByThread: ReadonlyMap<string, ThreadAttentionGroup>;
  destination: string;
  selected: ReadonlySet<string>;
  pending: boolean;
  toggle: (id: string) => void;
  renderThread: (thread: SidebarSnapshotRow) => ReactNode;
  target: ThreadAttentionGroup | undefined;
  name: string;
}

export function SearchGroupMembers({
  visibleCandidates,
  candidates,
  selectedOutsideSearch,
  groupByThread,
  destination,
  selected,
  pending,
  toggle,
  renderThread,
  target,
  name,
}: Props) {
  const isV2 = useShellPresentation() === 'v2';
  return (
    <div className="mt-2 space-y-1">
      {selectedOutsideSearch.length > 0 && (
        <p className="px-4 py-1 text-micro text-cafe-muted">
          另有 {selectedOutsideSearch.length} 条已选对话保留在列表下方。
        </p>
      )}
      {visibleCandidates.map((thread) => {
        const source = groupByThread.get(thread.id);
        const alreadyInTarget = Boolean(destination && source?.id === destination);
        const checked = selected.has(thread.id) && !alreadyInTarget;
        return (
          <div key={thread.id} className="flex min-w-0 items-start gap-1 px-2">
            <input
              type="checkbox"
              aria-label={`选择 ${thread.title || thread.id}`}
              data-select-thread={thread.id}
              checked={checked || alreadyInTarget}
              disabled={pending || alreadyInTarget}
              onChange={() => toggle(thread.id)}
              className="mt-5 h-4 w-4 shrink-0 accent-[var(--cafe-accent)]"
            />
            <div className="min-w-0 flex-1">
              {renderThread(thread)}
              <p className={`${isV2 ? 'pl-10 pr-5' : 'px-3'} pb-1 text-micro text-cafe-muted`}>
                {thread.pinned ? '已置顶' : '未置顶'} ·{' '}
                {alreadyInTarget
                  ? '已在目标 Group'
                  : source
                    ? checked
                      ? `将从「${groupTitle(source)}」移到「${target ? groupTitle(target) : name || '新 Group'}」`
                      : `已在「${groupTitle(source)}」`
                    : '尚未归组'}
              </p>
            </div>
          </div>
        );
      })}
      {candidates.length === 0 && (
        <p className="px-4 py-4 text-xs text-cafe-muted">没有匹配的普通对话；可以修改搜索，已选成员仍保留。</p>
      )}
    </div>
  );
}
