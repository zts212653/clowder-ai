'use client';

import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import {
  type GroupMutationResult,
  groupTitle,
  type SearchGroupRequest,
  type ThreadAttentionPreferences,
} from './search-group-types';
import { isGroupableThread, matchesThreadSearch } from './thread-search';
import type { ThreadAttentionGroupCommand } from './use-attention-clusters';

interface Props {
  request: SearchGroupRequest;
  threads: readonly SidebarSnapshotRow[];
  groups: readonly ThreadAttentionGroup[];
  renderThread: (thread: SidebarSnapshotRow) => ReactNode;
  onCommand: (command: ThreadAttentionGroupCommand) => Promise<GroupMutationResult>;
  onReload: () => Promise<ThreadAttentionPreferences | null>;
  onSaved: (result: ThreadAttentionPreferences, groupId: string, count: number) => void;
  onClose: () => void;
}

export function SearchGroupOrganizer({
  request,
  threads,
  groups,
  renderThread,
  onCommand,
  onReload,
  onSaved,
  onClose,
}: Props) {
  // Freeze the observed membership until an explicit refresh; a live update must not silently authorize a move.
  const [observedGroups, setObservedGroups] = useState(groups);
  const [query, setQuery] = useState(request.query);
  const [name, setName] = useState(
    /^f\d+$/i.test(request.query) ? request.query.toUpperCase() : request.query || '新 Group',
  );
  const [destination, setDestination] = useState(request.groupId ?? '');
  const [selected, setSelected] = useState(
    () =>
      new Set(
        threads
          .filter(
            (thread) =>
              isGroupableThread(thread) &&
              (request.threadId
                ? thread.id === request.threadId
                : Boolean(request.query) && matchesThreadSearch(thread, request.query)) &&
              !groups.some((group) => group.threadIds.includes(thread.id)),
          )
          .map((thread) => thread.id),
      ),
  );
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [failure, setFailure] = useState<{ error: string; conflict: boolean } | null>(null);
  const groupByThread = useMemo(
    () => new Map(observedGroups.flatMap((group) => group.threadIds.map((id) => [id, group] as const))),
    [observedGroups],
  );
  const candidates = threads.filter((thread) => isGroupableThread(thread) && matchesThreadSearch(thread, query));
  const selectedOutsideSearch = threads.filter(
    (thread) => selected.has(thread.id) && isGroupableThread(thread) && !matchesThreadSearch(thread, query),
  );
  const visibleCandidates = [...candidates, ...selectedOutsideSearch];
  const target = observedGroups.find((group) => group.id === destination);
  const currentGroup = request.threadId ? groupByThread.get(request.threadId) : undefined;
  const chosen = threads.filter(
    (thread) =>
      selected.has(thread.id) && isGroupableThread(thread) && groupByThread.get(thread.id)?.id !== destination,
  );
  const pinned = candidates.filter((thread) => thread.pinned).length;
  const ready = chosen.length >= (destination ? 1 : 2) && (destination ? Boolean(target) : Boolean(name.trim()));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const save = async () => {
    if (!ready || submitting.current || failure?.conflict) return;
    submitting.current = true;
    setPending(true);
    const threadIds = chosen.map((thread) => thread.id);
    const affected = new Set(chosen.flatMap((thread) => groupByThread.get(thread.id)?.id ?? []));
    if (destination) affected.add(destination);
    const result = await onCommand({
      action: 'organize',
      threadIds,
      expectedGroups: observedGroups
        .filter((group) => affected.has(group.id))
        .map(({ id, threadIds: ids }) => ({ id, threadIds: [...ids] })),
      ...(destination ? { groupId: destination } : { name: name.trim() }),
    });
    submitting.current = false;
    setPending(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    const saved = result.preferences.groups.find((group) => group.threadIds.includes(threadIds[0]));
    if (saved) onSaved(result.preferences, saved.id, chosen.length);
  };
  const reload = async () => {
    setPending(true);
    const preferences = await onReload();
    setPending(false);
    if (!preferences) {
      setFailure({ error: '未能读取对话组，请重新查看', conflict: true });
      return;
    }
    setObservedGroups(preferences.groups);
    setSelected(new Set());
    if (!preferences.groups.some((group) => group.id === destination)) setDestination('');
    setFailure(null);
  };
  const removeCurrent = async () => {
    if (!request.threadId || !currentGroup || submitting.current) return;
    submitting.current = true;
    setPending(true);
    const result = await onCommand({ action: 'remove', threadId: request.threadId, groupId: currentGroup.id });
    submitting.current = false;
    setPending(false);
    if (result.ok) onClose();
    else setFailure(result);
  };

  return (
    <section data-testid="search-group-editor" aria-label="批量整理 Group" aria-busy={pending} className="min-w-0">
      <div className="sticky top-0 z-20 mx-2 rounded-xl border border-cafe-subtle bg-cafe-surface-elevated p-3 shadow-[var(--console-shadow-soft)]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-cafe-black">整理 Group</h2>
          <button
            type="button"
            data-testid="search-group-cancel"
            disabled={pending}
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-cafe-muted disabled:opacity-40"
          >
            取消
          </button>
        </div>
        <p className="my-2 text-micro text-cafe-muted">
          全部匹配 {candidates.length} 条 · {pinned} 条已置顶、{candidates.length - pinned} 条未置顶
        </p>
        <fieldset disabled={pending} className="space-y-2 disabled:opacity-60">
          {currentGroup && (
            <button type="button" onClick={() => void removeCurrent()} className="text-xs text-conn-amber-text">
              从「{groupTitle(currentGroup)}」移出当前对话
            </button>
          )}
          <input
            aria-label="筛选待整理对话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索要加入的对话"
            className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 py-1.5 text-xs text-cafe-black"
          />
          <select
            aria-label="整理目标"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 py-1.5 text-xs text-cafe-black"
          >
            <option value="">新建 Group</option>
            {observedGroups.map((group) => (
              <option key={group.id} value={group.id}>
                加入 {groupTitle(group)}
              </option>
            ))}
          </select>
          {!destination && (
            <input
              aria-label="Group 名称"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 py-1.5 text-xs text-cafe-black"
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-micro">
            <span className="text-cafe-muted">
              已选 {chosen.length} 条{!destination && chosen.length < 2 ? ' · 新组至少 2 条' : ''}
            </span>
            <button
              type="button"
              onClick={() =>
                setSelected(
                  (current) =>
                    new Set([
                      ...current,
                      ...candidates.filter((thread) => !groupByThread.has(thread.id)).map((thread) => thread.id),
                    ]),
                )
              }
              className="text-cafe-accent"
            >
              选择未归组
            </button>
            <button type="button" onClick={() => setSelected(new Set())} className="text-cafe-muted">
              清空选择
            </button>
          </div>
          <button
            type="button"
            data-testid="search-group-save"
            disabled={!ready || failure?.conflict}
            onClick={() => void save()}
            className="w-full rounded-lg bg-cafe-accent px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
          >
            {pending
              ? '正在整理…'
              : failure
                ? '重试保存'
                : destination
                  ? `加入 Group · ${chosen.length} 条`
                  : `创建 Group · ${chosen.length} 条`}
          </button>
        </fieldset>
        {failure && (
          <div role="alert" className="mt-2 text-xs text-conn-amber-text">
            {failure.error}
            {failure.conflict && (
              <button type="button" disabled={pending} onClick={() => void reload()} className="ml-2 underline">
                重新查看
              </button>
            )}
          </div>
        )}
      </div>
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
                <p className="px-3 pb-1 text-micro text-cafe-muted">
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
    </section>
  );
}
