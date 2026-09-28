'use client';

import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import type { AttentionCluster } from './attention-clusters';
import { formatRelativeTime } from './thread-utils';

interface AttentionClusterHeaderProps {
  cluster: AttentionCluster;
  members: readonly SidebarSnapshotRow[];
  expanded: boolean;
  displayTitle: string;
  onToggle: () => void;
  onRename: (alias: string | null) => void;
  onAdd?: () => void;
  memberSort?: ThreadAttentionMemberSort;
  onMemberSort?: (mode: ThreadAttentionMemberSort) => void;
  sortingDisabled?: boolean;
}

interface AttentionClusterMemberProps {
  cluster: AttentionCluster;
  member: SidebarSnapshotRow;
  isFirst: boolean;
  isLast: boolean;
  renderThread: (thread: SidebarSnapshotRow) => ReactNode;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

export function AttentionClusterHeader({
  cluster,
  members,
  expanded,
  displayTitle,
  onToggle,
  onRename,
  onAdd,
  memberSort = 'manual',
  onMemberSort,
  sortingDisabled = false,
}: AttentionClusterHeaderProps) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(displayTitle);
  useEffect(() => setDraftName(displayTitle), [displayTitle]);
  const saveName = (event: FormEvent) => {
    event.preventDefault();
    if (!draftName.trim()) return;
    onRename(draftName);
    setEditingName(false);
  };
  const pinnedCount = members.filter((member) => member.pinned).length;
  const mentionCount = members.filter((member) => member.hasUserMention).length;
  const workingCount = members.filter((member) => member.presence.status === 'working').length;
  const unreadCount = members.reduce((sum, member) => sum + member.unreadCount, 0);
  const latestActivity = Math.max(...members.map((member) => member.lastActiveAt));

  return (
    <section
      data-attention-cluster={cluster.anchor}
      data-expanded={expanded}
      data-cluster-segment={expanded ? 'start' : 'only'}
      className={`relative mx-2 h-full min-h-[80px] bg-cafe-surface-elevated shadow-[var(--console-shadow-soft)] ${
        expanded ? 'rounded-t-xl' : 'rounded-xl'
      }`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`attention-members-${cluster.rootThreadId}`}
        onClick={onToggle}
        className="absolute inset-0 flex w-full min-w-0 flex-col justify-start gap-1 rounded-[inherit] px-3 py-2 text-left transition-colors hover:bg-[var(--console-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cafe-accent"
      >
        <span className={`flex w-full min-w-0 items-center gap-2 ${onMemberSort ? 'pr-[144px]' : 'pr-14'}`}>
          <Chevron expanded={expanded} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-cafe-black">{displayTitle}</span>
          <span
            className={
              onMemberSort
                ? 'sr-only'
                : 'shrink-0 rounded-full bg-cafe-surface-canvas px-1.5 py-0.5 text-micro font-medium text-cafe-muted'
            }
          >
            Group
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 pl-[22px] text-micro text-cafe-muted">
          {pinnedCount > 0 && <span>{pinnedCount} 个置顶</span>}
          {pinnedCount > 0 && <span aria-hidden="true">·</span>}
          <span>{members.length} 个对话</span>
          <span className="ml-auto shrink-0">{formatRelativeTime(latestActivity, false)}</span>
        </span>
        {(workingCount > 0 || unreadCount > 0 || mentionCount > 0) && (
          <span className="flex w-full min-w-0 items-center gap-1.5 pl-[22px] text-xs font-semibold leading-4">
            {workingCount > 0 && (
              <span
                title={`${workingCount} 个对话中的猫猫正在工作`}
                className="shrink-0 rounded-full bg-conn-amber-bg px-1.5 py-0.5 text-conn-amber-text"
              >
                进行中 {workingCount}
              </span>
            )}
            {unreadCount > 0 && (
              <span
                title={`${unreadCount} 条未读消息`}
                className="shrink-0 rounded-full bg-cafe-accent px-1.5 py-0.5 text-[var(--cafe-surface)]"
              >
                未读 {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
            {mentionCount > 0 && (
              <span
                title={`${mentionCount} 个对话中猫猫 @ 了你`}
                className="shrink-0 rounded-full bg-conn-red-bg px-1.5 py-0.5 text-conn-red-text"
              >
                @你 {mentionCount}
              </span>
            )}
          </span>
        )}
      </button>
      {onMemberSort && (
        <select
          aria-label={`${displayTitle} 组内排序`}
          title="运行优先在展开时排序；展开期间位置保持稳定。拖动整理时显示手动顺序。"
          value={memberSort}
          disabled={sortingDisabled}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'manual' || value === 'running-first') onMemberSort(value);
          }}
          className="absolute right-16 top-2 z-10 max-w-[88px] rounded-md border border-[var(--console-border-soft)] bg-cafe-surface-canvas py-0.5 text-micro text-cafe-muted disabled:opacity-50"
        >
          <option value="manual">手动顺序</option>
          <option value="running-first">运行优先</option>
        </select>
      )}
      {onAdd && (
        <button
          type="button"
          aria-label={`向 ${displayTitle} 添加对话`}
          title="添加对话"
          onClick={onAdd}
          className="absolute right-9 top-2 z-10 rounded-md p-1 text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-black"
        >
          +
        </button>
      )}
      <button
        type="button"
        aria-label={`重命名 ${displayTitle}`}
        title="修改私人显示名"
        onClick={() => setEditingName((current) => !current)}
        className="absolute right-2 top-2 z-10 rounded-md p-1 text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-black"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor">
          <path d="m3 11-.5 2.5L5 13l7.2-7.2-2-2L3 11Z" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </button>
      {editingName && (
        <form
          onSubmit={saveName}
          className="absolute inset-x-2 top-2 z-10 flex items-center gap-1.5 rounded-lg bg-cafe-surface-elevated p-2 shadow-[var(--console-shadow-soft)]"
        >
          <input
            aria-label="对话组名称"
            value={draftName}
            maxLength={120}
            onChange={(event) => setDraftName(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-[var(--console-border-soft)] bg-cafe-surface-canvas px-2 py-1 text-xs text-cafe-black"
          />
          <button type="submit" className="rounded-md px-2 py-1 text-xs text-conn-blue-text hover:bg-conn-blue-bg">
            保存
          </button>
          <button
            type="button"
            onClick={() => {
              onRename(null);
              setEditingName(false);
            }}
            className="rounded-md px-2 py-1 text-xs text-cafe-muted hover:bg-[var(--console-hover-bg)]"
          >
            恢复名称
          </button>
        </form>
      )}
    </section>
  );
}

export function AttentionClusterMember({
  cluster,
  member,
  isFirst,
  isLast,
  renderThread,
}: AttentionClusterMemberProps) {
  return (
    <div
      id={isFirst ? `attention-members-${cluster.rootThreadId}` : undefined}
      data-attention-cluster-member={cluster.anchor}
      data-cluster-segment={isLast ? 'end' : 'middle'}
      className="relative mx-2 h-20 !mt-0 pl-3"
    >
      <span
        data-cluster-rail="true"
        aria-hidden="true"
        className={`absolute left-[10px] top-0 w-px bg-cafe-muted/35 ${isLast ? 'h-[36px]' : 'bottom-0'}`}
      />
      <span
        data-group-anchor="true"
        aria-hidden="true"
        className="absolute left-[7px] top-[30px] h-1.5 w-1.5 rounded-full bg-cafe-muted/50"
      />
      <div className="h-full pl-1">{renderThread(member)}</div>
    </div>
  );
}
