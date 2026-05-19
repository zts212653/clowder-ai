'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Thread } from '@/stores/chat-types';
import type { ThreadLabel } from '@/stores/label-store';

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

  useEffect(() => {
    if (initialSuggestions && initialSuggestions.size > 0) {
      setSelections(initialSuggestions);
    }
  }, [initialSuggestions]);

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
        className="absolute inset-0 bg-[var(--console-overlay-medium)] cursor-default"
        tabIndex={-1}
        aria-label="关闭面板"
        onClick={onClose}
      />
      <div className="relative bg-cafe-surface rounded-xl shadow-2xl border border-cafe w-[480px] max-h-[70vh] flex flex-col">
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

        {failedIds.size > 0 && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-md bg-conn-red-bg border border-conn-red-ring text-xs text-conn-red-text">
            {failedIds.size} 个 thread 应用失败，请重试
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
          {threads.length === 0 ? (
            <p className="text-xs text-cafe-muted py-4 text-center">没有未分类的 thread</p>
          ) : (
            threads.map((thread) => {
              const selected = selections.get(thread.id) || [];
              const isFailed = failedIds.has(thread.id);
              return (
                <div
                  key={thread.id}
                  className={`border rounded-lg p-2.5 ${isFailed ? 'border-conn-red-ring bg-conn-red-bg/50' : 'border-cafe-subtle'}`}
                >
                  <p className="text-xs text-cafe-black truncate mb-1.5">{thread.title || thread.id}</p>
                  <div className="flex flex-wrap gap-1">
                    {labels.map((label) => {
                      const isSelected = selected.includes(label.id);
                      return (
                        <button
                          key={label.id}
                          type="button"
                          onClick={() => toggleLabel(thread.id, label.id)}
                          className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors flex items-center gap-1 ${
                            isSelected
                              ? 'border-cafe-muted bg-cafe-surface-elevated text-cafe-black'
                              : 'border-transparent text-cafe-muted hover:text-cafe-secondary'
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
              className="text-xs px-3 py-1.5 rounded-md bg-cafe-accent text-white disabled:opacity-40 transition-opacity"
            >
              {applying ? '应用中...' : `批量应用 (${assignedCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
