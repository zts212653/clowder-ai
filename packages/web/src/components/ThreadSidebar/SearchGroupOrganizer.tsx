'use client';

import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { SearchGroupMembers } from './SearchGroupMembers';
import { SearchGroupOverlay } from './SearchGroupOverlay';
import { matchingGroup, SearchGroupPicker } from './SearchGroupPicker';
import styles from './search-group-picker.module.css';
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
  recentGroupIds?: readonly string[];
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
  recentGroupIds,
  renderThread,
  onCommand,
  onReload,
  onSaved,
  onClose,
}: Props) {
  const isV2 = useShellPresentation() === 'v2';
  const editor = useRef<HTMLElement>(null);
  const destinationChosen = useRef(false);
  // Freeze the observed membership until an explicit refresh; a live update must not silently authorize a move.
  const [observedGroups, setObservedGroups] = useState(groups);
  const [query, setQuery] = useState(request.query);
  const [name, setName] = useState(
    /^f\d+$/i.test(request.query) ? request.query.toUpperCase() : request.query || '新 Group',
  );
  const [destination, setDestination] = useState(
    request.groupId ?? (isV2 ? matchingGroup(groups, request.query)[0]?.id : '') ?? '',
  );
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
  const alreadyInTarget = candidates.filter((thread) => target?.threadIds.includes(thread.id)).length;
  useEffect(() => {
    if (isV2 && !request.groupId && !destinationChosen.current)
      setDestination(matchingGroup(observedGroups, query)[0]?.id ?? '');
  }, [isV2, observedGroups, query, request.groupId]);
  useEffect(() => {
    if (!isV2) return;
    const previous = document.activeElement;
    editor.current?.querySelector<HTMLInputElement>('input[aria-label="搜索对话"]')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isV2]);
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

  const content = (
    <section
      ref={editor}
      data-testid={isV2 ? undefined : 'search-group-editor'}
      aria-label="批量整理 Group"
      aria-busy={pending}
      className="min-w-0"
    >
      <div
        className={
          isV2
            ? styles.header
            : 'sticky top-0 z-20 mx-2 rounded-xl border border-cafe-subtle bg-cafe-surface-elevated p-3 shadow-[var(--console-shadow-soft)]'
        }
      >
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
          {isV2 ? (
            <>
              匹配 {candidates.length} 条{target ? ` · 其中 ${alreadyInTarget} 条已在「${groupTitle(target)}」` : ''}
            </>
          ) : (
            <>
              全部匹配 {candidates.length} 条 · {pinned} 条已置顶、{candidates.length - pinned} 条未置顶
            </>
          )}
        </p>
        <fieldset disabled={pending} className="space-y-2 disabled:opacity-60">
          {currentGroup && (
            <button type="button" onClick={() => void removeCurrent()} className="text-xs text-conn-amber-text">
              从「{groupTitle(currentGroup)}」移出当前对话
            </button>
          )}
          <label className="block space-y-1 text-xs font-medium text-cafe-black">
            <span>搜索对话</span>
            <input
              aria-label="搜索对话"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索要加入的对话"
              className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 py-1.5 text-xs font-normal text-cafe-black"
            />
          </label>
          {isV2 ? (
            <div className="space-y-1">
              <p className="text-xs text-[var(--shell-muted)]">整理到</p>
              <SearchGroupPicker
                groups={observedGroups}
                destination={destination}
                onChange={(id) => {
                  destinationChosen.current = true;
                  setDestination(id);
                }}
                matchQuery={query}
                recentGroupIds={recentGroupIds}
                matchedThreadIds={candidates.map((thread) => thread.id)}
                disabled={pending}
              />
            </div>
          ) : (
            <label className="block space-y-1 text-xs font-medium text-cafe-black">
              <span>整理到</span>
              <select
                aria-label="整理到"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 py-1.5 text-xs font-normal text-cafe-black"
              >
                <option value="">新建 Group</option>
                {observedGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    加入 {groupTitle(group)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!destination && (
            <label className="block space-y-1 text-xs font-medium text-cafe-black">
              <span>新组名称</span>
              <input
                aria-label="新组名称"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 py-1.5 text-xs font-normal text-cafe-black"
              />
            </label>
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
                  ? isV2
                    ? `把另外 ${chosen.length} 条加入 ${target ? groupTitle(target) : ''}`
                    : `加入 Group · ${chosen.length} 条`
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
      <SearchGroupMembers
        visibleCandidates={visibleCandidates}
        candidates={candidates}
        selectedOutsideSearch={selectedOutsideSearch}
        groupByThread={groupByThread}
        destination={destination}
        selected={selected}
        pending={pending}
        toggle={toggle}
        renderThread={renderThread}
        target={target}
        name={name}
      />
    </section>
  );
  return isV2 ? (
    <SearchGroupOverlay pending={pending} onClose={onClose} focusRoot={editor}>
      {content}
    </SearchGroupOverlay>
  ) : (
    content
  );
}
