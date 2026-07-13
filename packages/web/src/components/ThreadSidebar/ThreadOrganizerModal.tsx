'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LABEL_COLOR } from '@/lib/color-defaults';
import type { Thread } from '@/stores/chat-types';
import { type ThreadLabel, useLabelStore } from '@/stores/label-store';

interface ThreadOrganizerModalProps {
  open: boolean;
  onClose: () => void;
  threads: Thread[];
  labels: ThreadLabel[];
  onApply: (assignments: Map<string, string[]>) => Promise<{ failedThreadIds: string[] }>;
  onSuggestAll?: () => void;
  initialSuggestions?: Map<string, string[]>;
  loading?: boolean;
}

export function ThreadOrganizerModal({
  open,
  onClose,
  threads,
  labels,
  onApply,
  onSuggestAll,
  initialSuggestions,
  loading,
}: ThreadOrganizerModalProps) {
  const [selections, setSelections] = useState<Map<string, string[]>>(new Map());
  const [applying, setApplying] = useState(false);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_LABEL_COLOR);
  const { createLabel, deleteLabel } = useLabelStore();

  useEffect(() => {
    if (initialSuggestions && initialSuggestions.size > 0) {
      setSelections(initialSuggestions);
    }
  }, [initialSuggestions]);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setShowCreate(false);
      setNewName('');
      setNewColor(DEFAULT_LABEL_COLOR);
    }
  }, [open]);

  const toggleLabel = useCallback((threadId: string, labelId: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = next.get(threadId) || [];
      if (current.includes(labelId)) {
        next.set(
          threadId,
          current.filter((id) => id !== labelId),
        );
      } else {
        next.set(threadId, [...current, labelId]);
      }
      return next;
    });
  }, []);

  const assignedCount = useMemo(() => {
    let count = 0;
    for (const labelIds of selections.values()) {
      if (labelIds.length > 0) count++;
    }
    return count;
  }, [selections]);

  const labelById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels]);

  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) => {
      const title = (thread.title ?? '').toLowerCase();
      const fallback = (thread.id === 'default' ? '大厅' : '未命名对话').toLowerCase();
      const project = (thread.projectPath ?? '').toLowerCase();
      const threadId = thread.id.toLowerCase();
      const labelText = [...(thread.labels ?? []), ...(selections.get(thread.id) ?? [])]
        .map((id) => labelById.get(id)?.name ?? '')
        .join(' ')
        .toLowerCase();
      return (
        title.includes(query) ||
        fallback.includes(query) ||
        project.includes(query) ||
        threadId.includes(query) ||
        labelText.includes(query)
      );
    });
  }, [labelById, searchQuery, selections, threads]);

  const handleCreateLabel = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    const created = await createLabel(name, newColor);
    if (!created) return;
    setShowCreate(false);
    setNewName('');
    setNewColor(DEFAULT_LABEL_COLOR);
  }, [createLabel, newColor, newName]);

  const handleDeleteLabel = useCallback(
    async (labelId: string) => {
      await deleteLabel(labelId);
      setSelections((prev) => {
        const next = new Map<string, string[]>();
        for (const [threadId, labelIds] of prev) {
          next.set(
            threadId,
            labelIds.filter((id) => id !== labelId),
          );
        }
        return next;
      });
    },
    [deleteLabel],
  );

  const handleApply = useCallback(async () => {
    if (assignedCount === 0) return;
    setApplying(true);
    setFailedIds(new Set());
    try {
      const visibleThreadIds = new Set(threads.map((t) => t.id));
      const validLabelIds = new Set(labels.map((l) => l.id));
      const toApply = new Map<string, string[]>();
      for (const [threadId, labelIds] of selections) {
        if (!visibleThreadIds.has(threadId)) continue;
        const valid = labelIds.filter((id) => validLabelIds.has(id));
        if (valid.length > 0) toApply.set(threadId, valid);
      }
      if (toApply.size === 0) return;
      const { failedThreadIds } = await onApply(toApply);
      if (failedThreadIds.length > 0) {
        setFailedIds(new Set(failedThreadIds));
      }
    } finally {
      setApplying(false);
    }
  }, [assignedCount, selections, onApply, threads, labels]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-[var(--console-overlay-medium)] backdrop-blur-sm cursor-default"
        tabIndex={-1}
        aria-label="关闭面板"
        onClick={onClose}
      />
      <div
        className="relative bg-cafe-surface rounded-lg shadow-2xl border border-cafe w-[640px] max-w-[calc(100vw-32px)] max-h-[78vh] flex flex-col"
        data-testid="thread-organizer-modal"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-cafe-subtle">
          <h3 className="text-sm font-medium text-cafe-black">整理未分类 Thread</h3>
          <div className="flex items-center gap-2">
            {onSuggestAll && (
              <button
                type="button"
                onClick={onSuggestAll}
                disabled={loading}
                className="text-xs px-2 py-1 rounded-md bg-conn-amber-bg text-conn-amber-text hover:bg-conn-amber-ring disabled:opacity-40 transition-colors flex items-center gap-1"
              >
                <svg
                  aria-hidden="true"
                  className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.064 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                  <path d="M20 3v4M22 5h-4" />
                </svg>
                {loading ? '分析中...' : '全部建议'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-cafe-muted hover:text-cafe-secondary"
              aria-label="关闭"
            >
              <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="border-b border-cafe-subtle px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-cafe-secondary">标签</span>
            <button
              type="button"
              onClick={() => setShowCreate((value) => !value)}
              className="text-micro text-cafe-accent hover:text-cafe-interactive"
            >
              添加标签
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {labels.length === 0 ? (
              <span className="text-micro text-cafe-muted">还没有标签</span>
            ) : (
              labels.map((label) => {
                const canDelete = !label.id.startsWith('pending:');
                return (
                  <span
                    key={label.id}
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--console-card-soft-bg)] px-1.5 py-0.5 text-micro text-cafe-secondary"
                  >
                    <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
                    <span>{label.name}</span>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteLabel(label.id)}
                        className="rounded-full text-cafe-muted hover:text-conn-red-text"
                        aria-label={`删除标签 ${label.name}`}
                      >
                        <svg aria-hidden="true" className="h-2.5 w-2.5" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M4.3 4.3a1 1 0 0 1 1.4 0L10 8.6l4.3-4.3a1 1 0 1 1 1.4 1.4L11.4 10l4.3 4.3a1 1 0 0 1-1.4 1.4L10 11.4l-4.3 4.3a1 1 0 0 1-1.4-1.4L8.6 10 4.3 5.7a1 1 0 0 1 0-1.4z" />
                        </svg>
                      </button>
                    )}
                  </span>
                );
              })
            )}
          </div>
          {showCreate && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="color"
                value={newColor}
                onChange={(event) => setNewColor(event.target.value)}
                className="h-5 w-5 flex-shrink-0 rounded border-0 p-0"
              />
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="标签名称"
                maxLength={20}
                className="min-w-0 flex-1 rounded-md border border-cafe-subtle bg-cafe-surface px-1.5 py-0.5 text-micro text-cafe-secondary focus:border-cafe-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleCreateLabel()}
                disabled={!newName.trim()}
                className="rounded-md bg-cafe-accent px-1.5 py-0.5 text-micro text-[var(--cafe-surface)] disabled:opacity-40"
              >
                创建
              </button>
            </div>
          )}
        </div>

        {failedIds.size > 0 && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-md bg-conn-red-bg border border-conn-red-ring text-xs text-conn-red-text">
            {failedIds.size} 个 thread 应用失败，请重试
          </div>
        )}

        <div className="border-b border-cafe-subtle px-4 py-2">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索对话、项目或 ID..."
            className="w-full rounded-lg bg-[var(--console-card-soft-bg)] px-2.5 py-1.5 text-xs text-cafe-secondary placeholder:text-cafe-muted focus:outline-none focus:ring-1 focus:ring-[var(--console-input-stroke)]"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
          {threads.length === 0 ? (
            <p className="text-xs text-cafe-muted py-4 text-center">没有未分类的 thread</p>
          ) : filteredThreads.length === 0 ? (
            <p className="text-xs text-cafe-muted py-4 text-center">没有匹配的 thread</p>
          ) : (
            filteredThreads.map((thread) => {
              const selected = selections.get(thread.id) || [];
              const isFailed = failedIds.has(thread.id);
              return (
                <div
                  key={thread.id}
                  data-thread-id={thread.id}
                  className={`group relative rounded-xl px-3 py-2 transition-colors hover:bg-[var(--console-hover-bg)] ${
                    isFailed ? 'bg-conn-red-bg/50 ring-1 ring-conn-red-ring' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-xs font-medium text-cafe-black">
                      {thread.title || thread.id}
                    </p>
                    {isFailed && <span className="text-micro text-conn-red-text">失败</span>}
                  </div>
                  <p className="mt-0.5 truncate text-micro text-cafe-muted">{thread.projectPath || '未关联项目'}</p>
                  <div
                    className="mt-1 flex flex-wrap gap-1"
                    data-testid={`thread-organizer-thread-labels-${thread.id}`}
                  >
                    {labels.map((label) => {
                      const isSelected = selected.includes(label.id);
                      return (
                        <button
                          key={label.id}
                          type="button"
                          onClick={() => toggleLabel(thread.id, label.id)}
                          className={`text-micro px-1.5 py-0.5 rounded-full border transition-colors flex items-center gap-1 ${
                            isSelected
                              ? 'border-cafe-muted bg-cafe-surface-elevated text-cafe-black'
                              : 'border-transparent bg-[var(--console-card-soft-bg)] text-cafe-muted hover:text-cafe-secondary'
                          }`}
                        >
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: label.color }}
                          />
                          {label.name}
                        </button>
                      );
                    })}
                    {labels.length === 0 && <span className="text-micro text-cafe-muted">暂无可用标签</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-cafe-subtle">
          <span className="text-xs text-cafe-muted">
            {assignedCount > 0 ? `已选 ${assignedCount} 个 thread` : '点击标签为 thread 分类'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-md text-cafe-muted hover:text-cafe-secondary"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={assignedCount === 0 || applying}
              className="text-xs px-3 py-1.5 rounded-md bg-cafe-accent text-[var(--cafe-surface)] disabled:opacity-40 transition-opacity"
            >
              {applying ? '应用中...' : `批量应用 (${assignedCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
