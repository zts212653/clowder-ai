'use client';

import { useMemo, useState } from 'react';
import type { Thread } from '@/stores/chat-types';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { MeetingCatWorkflowPicker } from './MeetingCatWorkflowPicker';
import {
  createMeetingDestination,
  meetingDestinationHandle,
  meetingDestinationLabel,
  meetingProjectLabel,
  selectedMeetingDestinationId,
} from './meeting-thread-destination';

const RECENT_LIMIT = 8;
const SEARCH_LIMIT = 20;

interface MeetingThreadDestinationPickerProps {
  readonly threads: readonly Thread[];
  readonly value: string;
  readonly suggestedTitle: string;
  readonly projectPath: string;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onChange: (destinationHandle: string) => void;
}

export function MeetingThreadDestinationPicker({
  threads,
  value,
  suggestedTitle,
  projectPath,
  loading,
  disabled,
  onChange,
}: MeetingThreadDestinationPickerProps) {
  const [query, setQuery] = useState('');
  const [localThreads, setLocalThreads] = useState<Thread[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState(() => `会议：${suggestedTitle}`);
  const [newCatId, setNewCatId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creationDisabled = creating || disabled;
  const canCreate = Boolean(newTitle.trim() && newCatId && !creationDisabled);

  const allThreads = useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    for (const thread of localThreads) byId.set(thread.id, thread);
    return [...byId.values()].sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  }, [localThreads, threads]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleThreads = useMemo(() => {
    const filtered = normalizedQuery
      ? allThreads.filter((thread) =>
          [meetingDestinationLabel(thread), thread.projectPath, thread.id].some((candidate) =>
            candidate.toLocaleLowerCase().includes(normalizedQuery),
          ),
        )
      : allThreads;
    return filtered.slice(0, normalizedQuery ? SEARCH_LIMIT : RECENT_LIMIT);
  }, [allThreads, normalizedQuery]);
  const selectedId = selectedMeetingDestinationId(value);
  const selected = allThreads.find((thread) => thread.id === selectedId);

  async function create(): Promise<void> {
    const title = newTitle.trim();
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const thread = await createMeetingDestination(title, projectPath, newCatId);
      setLocalThreads((current) => [...current.filter((item) => item.id !== thread.id), thread]);
      onChange(meetingDestinationHandle(thread.id));
      setQuery('');
      setShowCreate(false);
      await invalidateSidebarProjection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建保存位置失败');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="meeting-destination-picker">
      <div className="flex items-center justify-between gap-2">
        <span className="text-micro font-medium">保存位置</span>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setShowCreate((current) => !current);
          }}
          disabled={disabled}
          className="rounded-md border border-[var(--cafe-border)] px-2 py-1 text-micro hover:bg-[var(--cafe-muted)] disabled:opacity-50"
          data-testid="meeting-destination-create-toggle"
        >
          {showCreate ? '取消新建' : '新建保存位置'}
        </button>
      </div>

      {selected && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-[var(--semantic-success-subtle)] px-2 py-1.5 text-micro">
          <span className="truncate">已选择：{meetingDestinationLabel(selected)}</span>
          <button type="button" onClick={() => onChange('')} disabled={disabled} className="underline">
            清除
          </button>
        </div>
      )}

      {showCreate && (
        <div className="space-y-2 rounded-md border border-[var(--cafe-border)] p-2">
          <label className="block text-micro font-medium">
            保存位置名称
            <input
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              disabled={creating || disabled}
              className="mt-1 w-full rounded-md border border-[var(--cafe-border)] bg-[var(--cafe-surface)] p-2 text-sm"
              data-testid="meeting-destination-create-title"
            />
          </label>
          <MeetingCatWorkflowPicker value={newCatId} disabled={creationDisabled} onChange={setNewCatId} />
          <button
            type="button"
            onClick={() => void create()}
            disabled={!canCreate}
            className="rounded-md bg-[var(--semantic-success)] px-3 py-1.5 text-micro font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
            data-testid="meeting-destination-create-confirm"
          >
            {creating ? '创建中…' : '创建并选中'}
          </button>
        </div>
      )}

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索标题或项目"
        aria-label="搜索保存位置"
        disabled={disabled}
        className="w-full rounded-md border border-[var(--cafe-border)] bg-[var(--cafe-surface)] p-2 text-sm"
        data-testid="meeting-destination-search"
      />

      <div
        className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-[var(--cafe-border)] p-1"
        role="listbox"
        aria-label="保存位置搜索结果"
      >
        {loading && allThreads.length === 0 ? (
          <p className="p-2 text-micro text-cafe-secondary">正在加载保存位置…</p>
        ) : visibleThreads.length === 0 ? (
          <p className="p-2 text-micro text-cafe-secondary">没有匹配的保存位置，可以直接新建。</p>
        ) : (
          visibleThreads.map((thread) => {
            const isSelected = thread.id === selectedId;
            return (
              <button
                key={thread.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => onChange(meetingDestinationHandle(thread.id))}
                disabled={disabled}
                className={`block w-full rounded-md px-2 py-1.5 text-left text-micro disabled:opacity-50 ${
                  isSelected ? 'bg-[var(--semantic-success-subtle)]' : 'hover:bg-[var(--cafe-muted)]'
                }`}
                data-testid={`meeting-destination-${thread.id}`}
              >
                <span className="block truncate font-medium">{meetingDestinationLabel(thread)}</span>
                <span className="block truncate text-cafe-secondary">
                  项目：{meetingProjectLabel(thread.projectPath)}
                </span>
              </button>
            );
          })
        )}
      </div>
      {!normalizedQuery && allThreads.length > RECENT_LIMIT && (
        <p className="text-micro text-cafe-secondary">显示最近 {RECENT_LIMIT} 条；输入关键词可搜索全部。</p>
      )}
      {error && <p className="text-micro text-[var(--semantic-error)]">{error}</p>}
    </div>
  );
}
