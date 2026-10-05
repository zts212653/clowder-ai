'use client';

/**
 * F322 original-B: what the queue's buttons DO. Moved out of QueuePanel without changing a request, a body,
 * a guard, a confirmation or a word of toast copy, so the old panel and the one-row surface press the very
 * same endpoints. (Steer, retry and force-reset keep living in useQueueActionConvergence.)
 */
import type { QueueRecoveryAction } from '@cat-cafe/shared';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { composerInsertFromRecall, requestTrueRecall, TrueRecallRequestError } from '@/utils/true-recall';
import { recoveryNoStartCopy, reminderResultCopy } from './queue-toast-copy';
import type { QueueView } from './useQueueView';

export function useQueueCommands(
  threadId: string,
  view: Pick<QueueView, 'queue' | 'queueKnown' | 'visibleEntries'>,
  refreshQueue: () => Promise<boolean>,
) {
  const { queue, queueKnown, visibleEntries } = view;
  const setQueue = useChatStore((s) => s.setQueue);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const addToast = useToastStore((s) => s.addToast);
  const [remindingTargetKeys, setRemindingTargetKeys] = useState<Set<string>>(() => new Set());

  const handleRemove = useCallback(
    async (action: Extract<QueueRecoveryAction, { kind: 'withdraw' }>) => {
      if (!queueKnown) return;
      const prevQueue = queue;
      setQueue(
        threadId,
        prevQueue.filter((e) => e.id !== action.entryId),
      );
      try {
        const res = await apiFetch(action.request.path, { method: action.request.method });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setQueue(threadId, prevQueue);
          addToast({
            type: 'error',
            title: '停止失败',
            message: data?.error ?? '停止后续处理失败，请重试',
            threadId,
            duration: 5000,
          });
          return;
        }
        addToast({
          type: 'success',
          title: '已停止后续处理',
          message: '原消息与已经发生的读取事实仍保留在历史中',
          threadId,
          duration: 3000,
        });
      } catch {
        setQueue(threadId, prevQueue);
        addToast({
          type: 'error',
          title: '停止失败',
          message: '停止后续处理失败，请重试',
          threadId,
          duration: 5000,
        });
      }
    },
    [addToast, queue, queueKnown, setQueue, threadId],
  );

  const handleRecallEdit = useCallback(
    async (entryId: string) => {
      if (!queueKnown) return;
      const entry = queue.find((e) => e.id === entryId);
      if (!entry) return;
      if (!entry.messageId) {
        addToast({
          type: 'error',
          title: '无法撤回这条消息',
          message: '缺少原消息身份；可以改用“停止后续处理”。',
          threadId,
          duration: 5000,
        });
        return;
      }

      try {
        const result = await requestTrueRecall({
          threadId,
          messageId: entry.messageId,
          confirmAppend: () => window.confirm('输入框已有草稿。撤回正文会空一行追加到当前草稿末尾，是否继续？'),
        });
        if (!result) return;
        setQueue(threadId, result.queue);
        const insert = composerInsertFromRecall(result);
        if (insert) setPendingChatInsert(insert);
        addToast({
          type: result.verdict === 'exposed' ? 'info' : 'success',
          title: result.verdict === 'exposed' ? '正文已撤回 · 猫曾读取' : '已撤回并回填输入框',
          message:
            result.verdict === 'exposed'
              ? '未读猫已停止后续处理；已读回合不会被普通撤回中断。'
              : '正文已从消息历史转移到持久草稿，可修改后重新发送。',
          threadId,
          duration: 4000,
        });
      } catch (error) {
        const conflict = error instanceof TrueRecallRequestError && error.code === 'DRAFT_REVISION_MISMATCH';
        addToast({
          type: 'error',
          title: conflict ? '草稿已在别处更新' : '撤回并重新编辑失败',
          message: conflict ? '原消息和两份草稿都没有改变；刷新输入框后再试。' : (error as Error).message,
          threadId,
          duration: 5000,
        });
      }
    },
    [addToast, queue, queueKnown, setPendingChatInsert, setQueue, threadId],
  );

  const handleContinue = useCallback(async () => {
    if (!queueKnown) return;
    try {
      const res = await apiFetch(`/api/threads/${threadId}/queue/next`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.started !== true) {
        // A re-read that throws means "not refreshed", the same as one that answers false.
        const refreshed = await refreshQueue().catch(() => false);
        const feedback = recoveryNoStartCopy(refreshed, data?.error);
        addToast({
          ...feedback,
          threadId,
          duration: 5000,
        });
      }
    } catch {
      addToast({
        type: 'error',
        title: '队列恢复失败',
        message: '请求没有完成，请重试。',
        threadId,
        duration: 5000,
      });
    }
  }, [addToast, queueKnown, refreshQueue, threadId]);

  const handleClear = useCallback(async () => {
    if (!queueKnown) return;
    try {
      const res = await apiFetch(`/api/threads/${threadId}/queue`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(data?.queue)) setQueue(threadId, data.queue);
        addToast({
          type: 'error',
          title: data?.code === 'QUEUE_WITHDRAWAL_PARTIAL' ? '已停止部分消息' : '停止失败',
          message: data?.error ?? '停止后续处理失败，请重试',
          threadId,
          duration: 5000,
        });
        return;
      }
      addToast({
        type: 'success',
        title: '已全部停止后续处理',
        message: '原消息与已经发生的读取事实仍保留在历史中',
        threadId,
        duration: 3000,
      });
    } catch {
      addToast({
        type: 'error',
        title: '停止失败',
        message: '停止后续处理失败，请重试',
        threadId,
        duration: 5000,
      });
    }
  }, [addToast, queueKnown, setQueue, threadId]);

  const handleRemind = useCallback(
    async (entryId: string, targetCatId: string) => {
      if (!queueKnown) return;
      const key = `${entryId}:${targetCatId}`;
      setRemindingTargetKeys((current) => new Set(current).add(key));
      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/${entryId}/remind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetCatId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message =
            data?.code === 'NO_ACTIVE_INVOCATION'
              ? '这只猫当前没有可接收提醒的工作轮次。'
              : (data?.error ?? '提醒请求没有完成，请重试。');
          addToast({ type: 'error', title: '提醒未送达', message, threadId, duration: 5000 });
          return;
        }
        addToast({ ...reminderResultCopy(data?.state), threadId, duration: 3000 });
      } catch {
        addToast({
          type: 'error',
          title: '提醒未送达',
          message: '提醒请求没有完成，请重试。',
          threadId,
          duration: 5000,
        });
      } finally {
        setRemindingTargetKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [addToast, queueKnown, threadId],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!queueKnown || !over || active.id === over.id) return;

      // Only queued entries have an order to change: the server answers 400 for a processing one, and the list can
      // show a stuck processing message. It is neither draggable nor a drop target.
      const reorderable = visibleEntries.filter((e) => e.status === 'queued');
      const oldIndex = reorderable.findIndex((e) => e.id === active.id);
      const newIndex = reorderable.findIndex((e) => e.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(reorderable, oldIndex, newIndex);
      const positions = reordered.map((e, i) => ({ entryId: e.id, position: i }));

      const prevQueue = queue;
      setQueue(
        threadId,
        queue.map((e) => {
          const pos = positions.find((p) => p.entryId === e.id);
          return pos ? { ...e, position: pos.position } : e;
        }),
      );

      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/reorder`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positions }),
        });
        if (!res.ok) {
          setQueue(threadId, prevQueue);
          addToast({ type: 'error', title: '排序失败', message: '排序失败，请重试', threadId, duration: 5000 });
        }
      } catch {
        setQueue(threadId, prevQueue);
        addToast({ type: 'error', title: '排序失败', message: '排序失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, queue, queueKnown, setQueue, threadId, visibleEntries],
  );

  return {
    remindingTargetKeys,
    handleRemove,
    handleRecallEdit,
    handleContinue,
    handleClear,
    handleRemind,
    handleDragEnd,
  };
}
