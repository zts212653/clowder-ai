'use client';

import { useCallback, useState } from 'react';
import type { TrueRecallResponse } from '@/stores/chat-types';
import type { ChatMessage } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { composerInsertFromRecall, requestTrueRecall, TrueRecallRequestError } from '@/utils/true-recall';

interface TrueRecallActionButtonProps {
  message: ChatMessage;
  threadId: string;
}

function applyRecallResult(message: ChatMessage, threadId: string, result: TrueRecallResponse): void {
  const store = useChatStore.getState();
  store.setQueue(threadId, result.queue);
  const insert = composerInsertFromRecall(result);
  if (insert) store.setPendingChatInsert(insert);
  if (result.verdict === 'zero_exposure') {
    store.removeThreadMessage(threadId, message.id);
    return;
  }
  store.patchThreadMessage(threadId, message.id, {
    content: '',
    extra: { ...message.extra, recall: result.message.recall },
  });
}

function showRecallSuccess(result: TrueRecallResponse, threadId: string): void {
  const exposed = result.verdict === 'exposed';
  useToastStore.getState().addToast({
    type: exposed ? 'info' : 'success',
    title: exposed ? '正文已撤回 · 猫曾读取' : '已撤回并回填输入框',
    message: exposed
      ? '未读猫已停止后续处理；已读回合不会被普通撤回中断。'
      : '正文已从消息历史转移到持久草稿，可修改后重新发送。',
    threadId,
    duration: 4000,
  });
}

function showRecallError(error: unknown, threadId: string): void {
  const conflict = error instanceof TrueRecallRequestError && error.code === 'DRAFT_REVISION_MISMATCH';
  useToastStore.getState().addToast({
    type: 'error',
    title: conflict ? '草稿已在别处更新' : '撤回并重新编辑失败',
    message: conflict ? '原消息和两份草稿都没有改变；刷新输入框后再试。' : (error as Error).message,
    threadId,
    duration: 5000,
  });
}

export function TrueRecallActionButton({ message, threadId }: TrueRecallActionButtonProps) {
  const canTrueRecall = Boolean(message.extra?.queueReceipt) && !message.extra?.recall;
  const [isPending, setIsPending] = useState(false);

  const handleTrueRecall = useCallback(async () => {
    if (isPending) return;
    setIsPending(true);
    try {
      const result = await requestTrueRecall({
        threadId,
        messageId: message.id,
        confirmAppend: () => window.confirm('输入框已有草稿。撤回正文会空一行追加到当前草稿末尾，是否继续？'),
      });
      if (!result) return;
      applyRecallResult(message, threadId, result);
      showRecallSuccess(result, threadId);
    } catch (error) {
      showRecallError(error, threadId);
    } finally {
      setIsPending(false);
    }
  }, [isPending, message, threadId]);

  if (!canTrueRecall) return null;
  return (
    <button
      type="button"
      onClick={handleTrueRecall}
      disabled={isPending}
      className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-conn-blue-text transition-colors"
      title="撤回并重新编辑"
    >
      <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l-4-4 4-4m-4 4h11a4 4 0 014 4v1" />
      </svg>
    </button>
  );
}
