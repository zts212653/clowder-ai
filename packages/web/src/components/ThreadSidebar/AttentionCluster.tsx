'use client';

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
  const latestActivity = Math.max(...members.map((member) => member.lastActiveAt));

  return (
    <section
      data-attention-cluster={cluster.anchor}
      data-expanded={expanded}
      data-cluster-segment={expanded ? 'start' : 'only'}
      className={`relative mx-2 h-full bg-cafe-surface-elevated shadow-[var(--console-shadow-soft)] ${
        expanded ? 'rounded-t-xl' : 'rounded-xl'
      }`}
    >
      <div className="flex min-w-0 items-start">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`attention-members-${cluster.rootThreadId}`}
          onClick={onToggle}
          className="min-w-0 flex-1 px-3 py-2.5 text-left transition-colors hover:bg-[var(--console-hover-bg)]"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Chevron expanded={expanded} />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-cafe-black">{displayTitle}</span>
            <span className="shrink-0 rounded-full bg-cafe-surface-canvas px-1.5 py-0.5 text-micro font-medium text-cafe-muted">
              Group
            </span>
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-[22px] text-micro text-cafe-muted">
            {pinnedCount > 0 && <span>{pinnedCount} 个置顶</span>}
            {pinnedCount > 0 && <span aria-hidden="true">·</span>}
            <span>{members.length} 个对话</span>
            {mentionCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-semibold text-conn-amber-text">{mentionCount} 个 @你</span>
              </>
            ) : workingCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{workingCount} 个进行中</span>
              </>
            ) : null}
            <span className="ml-auto shrink-0">{formatRelativeTime(latestActivity, false)}</span>
          </span>
        </button>
        <button
          type="button"
          aria-label={`重命名 ${displayTitle}`}
          title="修改私人显示名"
          onClick={() => setEditingName((current) => !current)}
          className="mr-2 mt-2 rounded-md p-1 text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-black"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor">
            <path d="m3 11-.5 2.5L5 13l7.2-7.2-2-2L3 11Z" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

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
      className="relative mx-2 h-full !mt-0 pl-3"
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
