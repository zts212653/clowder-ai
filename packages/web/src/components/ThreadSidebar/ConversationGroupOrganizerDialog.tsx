'use client';

import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import type { ThreadAttentionGroupCommand } from './use-attention-clusters';

interface ConversationGroupOrganizerDialogProps {
  thread: SidebarSnapshotRow;
  threads: readonly SidebarSnapshotRow[];
  groups: readonly ThreadAttentionGroup[];
  onCommand: (command: ThreadAttentionGroupCommand) => void;
  onClose: () => void;
}

function groupTitle(group: ThreadAttentionGroup): string {
  return group.name?.trim() || `${group.threadIds.length} 个对话`;
}

export function ConversationGroupOrganizerDialog({
  thread,
  threads,
  groups,
  onCommand,
  onClose,
}: ConversationGroupOrganizerDialogProps) {
  const currentGroup = groups.find((group) => group.threadIds.includes(thread.id));
  const availableGroups = groups.filter((group) => group.id !== currentGroup?.id);
  const claimed = useMemo(() => new Set(groups.flatMap((group) => group.threadIds)), [groups]);
  const peers = threads.filter(
    (candidate) =>
      candidate.id !== thread.id &&
      candidate.id !== 'default' &&
      !candidate.isHubThread &&
      !candidate.systemKind &&
      !claimed.has(candidate.id),
  );
  const [peerId, setPeerId] = useState(peers[0]?.id ?? '');

  const commit = (command: ThreadAttentionGroupCommand) => {
    onCommand(command);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-group-organizer-title"
        className="w-full max-w-sm rounded-2xl border border-cafe-subtle bg-cafe-surface p-4 shadow-[var(--console-shadow-soft)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="conversation-group-organizer-title" className="text-sm font-semibold text-cafe-black">
              整理 Group
            </h2>
            <p className="mt-1 line-clamp-2 text-xs text-cafe-muted">{thread.title || '未命名对话'}</p>
          </div>
          <button
            type="button"
            aria-label="关闭 Group 整理"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-cafe-muted hover:bg-[var(--console-hover-bg)]"
          >
            关闭
          </button>
        </div>

        {currentGroup && (
          <button
            type="button"
            onClick={() => commit({ action: 'remove', groupId: currentGroup.id, threadId: thread.id })}
            className="mt-4 w-full rounded-lg bg-conn-red-bg px-3 py-2 text-left text-xs font-medium text-conn-red-text"
          >
            从“{groupTitle(currentGroup)}”移出
          </button>
        )}

        {availableGroups.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-micro font-medium text-cafe-muted">移到已有 Group</p>
            <div className="space-y-1">
              {availableGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => commit({ action: 'move', groupId: group.id, threadId: thread.id })}
                  className="w-full rounded-lg bg-cafe-surface-elevated px-3 py-2 text-left text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
                >
                  {groupTitle(group)}
                </button>
              ))}
            </div>
          </div>
        )}

        {peers.length > 0 && (
          <div className="mt-4">
            <label htmlFor="conversation-group-peer" className="mb-2 block text-micro font-medium text-cafe-muted">
              与另一条对话新建 Group
            </label>
            <div className="flex gap-2">
              <select
                id="conversation-group-peer"
                value={peerId}
                onChange={(event) => setPeerId(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-cafe-subtle bg-cafe-surface-elevated px-2 py-2 text-xs text-cafe-secondary"
              >
                {peers.map((peer) => (
                  <option key={peer.id} value={peer.id}>
                    {peer.title || '未命名对话'}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!peerId}
                onClick={() => commit({ action: 'create', threadIds: [peerId, thread.id] })}
                className="shrink-0 rounded-lg bg-cafe-accent px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
              >
                新建 Group
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
