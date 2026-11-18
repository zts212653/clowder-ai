'use client';

import type { TtsVoiceSelection } from '@cat-cafe/shared';
import { useToastStore } from '@/stores/toastStore';

let currentNotice: string | null = null;

export function showTtsVoiceWarning(
  selection: Pick<TtsVoiceSelection, 'warnings'> | undefined,
  threadId?: string,
): void {
  const message = selection?.warnings.join(' ');
  const store = useToastStore.getState();
  if (
    currentNotice &&
    store.toasts.some((toast) => toast.id === currentNotice && toast.message === message && toast.threadId === threadId)
  )
    return;
  if (currentNotice) store.removeToast(currentNotice);
  currentNotice = message
    ? store.addToast({ type: 'info', title: '语音声线提示', message, duration: 0, ...(threadId ? { threadId } : {}) })
    : null;
}
