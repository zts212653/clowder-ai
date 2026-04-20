'use client';

import { useCallback, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import { ConfirmDialog } from './ConfirmDialog';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

function showErrorToast(title: string, body?: Record<string, unknown>) {
  useToastStore.getState().addToast({
    type: 'error',
    title,
    message: (body?.error as string) ?? '操作未成功，请重试',
    duration: 4000,
  });
}

type DialogState =
  | { type: 'none' }
  | { type: 'soft-delete' }
  | { type: 'hard-delete'; threadTitle: string | null }
  | { type: 'edit'; editedContent: string }
  | { type: 'branch-confirm'; editedContent: string }
  | { type: 'branch-direct' };

interface MessageActionsProps {
  message: ChatMessage;
  threadId: string;
  children: React.ReactNode;
}

export function MessageActions({ message, threadId, children }: MessageActionsProps) {
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' });
  const removeThreadMessage = useChatStore((s) => s.removeThreadMessage);

  const isUser = message.type === 'user' && !message.catId;
  const isAssistant = message.type === 'assistant' || (message.type === 'user' && !!message.catId);
  const canAct = (isUser || isAssistant) && !message.isStreaming;
  const toolbarPositionClass = isUser ? 'top-8' : 'top-1';

  const handleSoftDelete = useCallback(() => setDialog({ type: 'soft-delete' }), []);

  const handleHardDelete = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, { method: 'GET' });
      const thread = res.ok ? await res.json() : null;
      setDialog({ type: 'hard-delete', threadTitle: thread?.title ?? null });
    } catch {
      setDialog({ type: 'hard-delete', threadTitle: null });
    }
  }, [threadId]);

  const handleEdit = useCallback(() => {
    setDialog({ type: 'edit', editedContent: message.content });
  }, [message.content]);

  const handleBranchDirect = useCallback(() => setDialog({ type: 'branch-direct' }), []);

  const confirmSoftDelete = useCallback(async () => {
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: getUserId(), mode: 'soft' }),
      });
      if (res.ok) {
        removeThreadMessage(threadId, message.id);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('删除失败', body);
      }
    } catch {
      showErrorToast('删除失败');
    }
  }, [message.id, threadId, removeThreadMessage]);

  const confirmHardDelete = useCallback(async () => {
    if (dialog.type !== 'hard-delete') return;
    const confirmTitle = dialog.threadTitle ?? '确认删除';
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: getUserId(), mode: 'hard', confirmTitle }),
      });
      if (res.ok) {
        removeThreadMessage(threadId, message.id);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('删除失败', body);
      }
    } catch {
      showErrorToast('删除失败');
    }
  }, [dialog, message.id, threadId, removeThreadMessage]);

  const handleBranchConfirm = useCallback(() => {
    if (dialog.type !== 'edit') return;
    setDialog({ type: 'branch-confirm', editedContent: dialog.editedContent });
  }, [dialog]);

  const confirmBranch = useCallback(async () => {
    if (dialog.type !== 'branch-confirm') return;
    const { editedContent } = dialog;
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/threads/${threadId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromMessageId: message.id,
          editedContent: editedContent !== message.content ? editedContent : undefined,
          userId: getUserId(),
        }),
      });
      if (res.ok) {
        const { threadId: newThreadId } = await res.json();
        pushThreadRouteWithHistory(newThreadId, typeof window !== 'undefined' ? window : undefined);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('分支创建失败', body);
      }
    } catch {
      showErrorToast('分支创建失败');
    }
  }, [dialog, message.id, message.content, threadId]);

  const branchingRef = useRef(false);
  const confirmBranchDirect = useCallback(async () => {
    if (branchingRef.current) return;
    branchingRef.current = true;
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/threads/${threadId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromMessageId: message.id, userId: getUserId() }),
      });
      if (res.ok) {
        const { threadId: newThreadId } = await res.json();
        pushThreadRouteWithHistory(newThreadId, typeof window !== 'undefined' ? window : undefined);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('分支创建失败', body);
      }
    } catch {
      showErrorToast('分支创建失败');
    } finally {
      branchingRef.current = false;
    }
  }, [message.id, threadId]);

  const close = useCallback(() => setDialog({ type: 'none' }), []);

  return (
    <div className="group relative">
      {children}

      {canAct && (
        <div
          className={`opacity-0 group-hover:opacity-100 absolute ${toolbarPositionClass} right-1 flex gap-0.5 transition-opacity bg-cafe-surface/90 rounded-lg shadow-sm border border-cafe px-1 py-0.5`}
        >
          <button
            onClick={handleSoftDelete}
            className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-red-500 transition-colors"
            title="删除"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
          <button
            onClick={handleBranchDirect}
            className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-green-600 transition-colors"
            title="从这里分支"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </button>
          {isUser && (
            <button
              onClick={handleEdit}
              className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-blue-500 transition-colors"
              title="编辑 (创建分支)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
            </button>
          )}
          <button
            onClick={handleHardDelete}
            className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-red-600 transition-colors"
            title="永久删除"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Soft delete confirmation */}
      <ConfirmDialog
        open={dialog.type === 'soft-delete'}
        title="删除消息"
        message="确认删除此消息？删除后可恢复。"
        confirmLabel="删除"
        variant="danger"
        onConfirm={confirmSoftDelete}
        onCancel={close}
      />

      {/* Hard delete confirmation — requires title input */}
      <ConfirmDialog
        open={dialog.type === 'hard-delete'}
        title="永久删除"
        message="此操作不可恢复。请输入对话标题以确认。"
        requireInput={dialog.type === 'hard-delete' ? (dialog.threadTitle ?? '确认删除') : undefined}
        inputPlaceholder={dialog.type === 'hard-delete' && dialog.threadTitle ? '输入对话标题' : '输入 "确认删除"'}
        confirmLabel="永久删除"
        variant="danger"
        onConfirm={confirmHardDelete}
        onCancel={close}
      />

      {/* Edit: inline textarea */}
      {dialog.type === 'edit' && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={close}>
          <div
            className="bg-cafe-surface rounded-xl shadow-xl p-6 max-w-lg w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold mb-2">编辑消息</h3>
            <textarea
              value={dialog.editedContent}
              onChange={(e) => setDialog({ ...dialog, editedContent: e.target.value })}
              className="w-full border border-cafe rounded-lg px-3 py-2 text-sm mb-4 h-32 resize-y focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={close}
                className="px-4 py-2 text-sm text-cafe-secondary hover:bg-cafe-surface-elevated rounded-lg"
              >
                取消
              </button>
              <button
                onClick={handleBranchConfirm}
                disabled={!dialog.editedContent.trim()}
                className="px-4 py-2 text-sm text-white bg-blue-500 hover:bg-blue-600 rounded-lg disabled:opacity-40"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Branch confirmation (from edit) */}
      <ConfirmDialog
        open={dialog.type === 'branch-confirm'}
        title="创建分支"
        message="编辑将从此消息创建一个新的对话分支。原对话保留不变。是否继续？"
        confirmLabel="创建分支"
        onConfirm={confirmBranch}
        onCancel={close}
      />

      {/* Direct branch confirmation (no edit) */}
      <ConfirmDialog
        open={dialog.type === 'branch-direct'}
        title="从这里分支"
        message="将从此消息创建一个新的对话分支，复制到这条消息为止的所有历史。原对话保留不变。"
        confirmLabel="创建分支"
        onConfirm={confirmBranchDirect}
        onCancel={close}
      />
    </div>
  );
}
