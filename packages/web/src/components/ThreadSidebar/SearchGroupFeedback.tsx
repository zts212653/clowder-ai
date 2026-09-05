'use client';

import { useRef, useState } from 'react';
import rawTips from '@/lib/capability-tips.seed.json';
import type { GroupMutationResult, GroupUndoReceipt } from './search-group-types';
import type { ThreadAttentionGroupCommand } from './use-attention-clusters';

const TIP_KEY = 'cat-cafe:f277:search-group-tip-dismissed:v1';
const tip = rawTips.find((entry) => entry.id === 'feature-f277-search-group');

export function useSearchGroupTip() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(TIP_KEY) === 'true';
    } catch {
      return false;
    }
  });
  return {
    dismissed,
    dismiss: () => {
      setDismissed(true);
      try {
        window.localStorage.setItem(TIP_KEY, 'true');
      } catch {
        /* Keep the current session dismissal. */
      }
    },
  };
}

export function SearchGroupTip({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      data-testid="search-group-tip"
      className="mx-3 my-1 flex items-start gap-2 rounded-lg bg-cafe-surface-elevated px-2 py-2 text-micro text-cafe-muted"
    >
      <p className="min-w-0 flex-1">{tip?.body}</p>
      <button
        type="button"
        aria-label="关闭搜索整理提示"
        onClick={onDismiss}
        className="shrink-0 rounded px-1 hover:text-cafe-black"
      >
        ×
      </button>
    </div>
  );
}

export function SearchGroupAction({
  count,
  loadState,
  onOpen,
  onRetry,
}: {
  count: number;
  loadState: 'loading' | 'ready' | 'error';
  onOpen: () => void;
  onRetry: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="search-group-organize"
      disabled={loadState === 'loading'}
      onClick={loadState === 'error' ? onRetry : onOpen}
      className="mx-2 min-w-0 rounded-lg border border-cafe-accent/40 px-2 py-1 text-micro font-medium text-cafe-accent disabled:opacity-40"
    >
      {loadState === 'error' ? '读取 Group 失败 · 重试' : `整理全部 ${count} 条`}
    </button>
  );
}

export interface SearchGroupSuccess {
  operationId: number;
  groupId: string;
  count: number;
  undo?: GroupUndoReceipt;
}
export function SearchGroupFeedback({
  success,
  onCommand,
  onClose,
  onLocate,
}: {
  success: SearchGroupSuccess;
  onCommand: (command: ThreadAttentionGroupCommand) => Promise<GroupMutationResult>;
  onClose: () => void;
  onLocate: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const [conflict, setConflict] = useState(false);
  const submitting = useRef(false);
  const undo = async () => {
    if (submitting.current || !success.undo) return;
    submitting.current = true;
    setPending(true);
    const result = await onCommand({ action: 'undo', ...success.undo });
    submitting.current = false;
    setPending(false);
    if (result.ok) {
      setUndone(true);
      setError(null);
    } else {
      setError(result.conflict ? '本次整理已无法撤销，当前分组保持不变。' : '撤销失败，请重试');
      setConflict(result.conflict);
    }
  };
  return (
    <div
      role="status"
      data-testid="search-group-success"
      className="mx-3 my-2 rounded-lg bg-cafe-surface-elevated px-3 py-2 text-xs text-cafe-secondary"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1">{undone ? '已撤销本次整理' : `已整理 ${success.count} 条`}</span>
        {!undone && (
          <button type="button" onClick={onLocate} className="text-cafe-accent">
            查看 Group
          </button>
        )}
        {!undone && success.undo && !conflict && (
          <button
            type="button"
            data-testid="search-group-undo"
            disabled={pending}
            onClick={() => void undo()}
            className="text-cafe-accent disabled:opacity-40"
          >
            {pending ? '正在撤销…' : '撤销'}
          </button>
        )}
        <button type="button" aria-label="关闭整理结果" disabled={pending} onClick={onClose}>
          ×
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-conn-amber-text">
          {error}
        </p>
      )}
    </div>
  );
}
