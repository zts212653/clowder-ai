'use client';

import { useChatStore } from '@/stores/chatStore';

export const REPLY_RECALL_OPEN_EVENT = 'cat-cafe:open-reply-recall';

export interface ReplyRecallTarget {
  threadId: string;
  invocationId: string;
  catId?: string;
}

export function readReplyRecallTarget(url: URL): ReplyRecallTarget | undefined {
  const invocationId = url.searchParams.get('recallInv')?.trim();
  const threadId = url.searchParams.get('recallThread')?.trim();
  const catId = url.searchParams.get('recallCat')?.trim();
  if (!invocationId || !threadId) return undefined;
  return { threadId, invocationId, ...(catId ? { catId } : {}) };
}

function writeReplyRecallTarget(target: ReplyRecallTarget): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('workspaceMode', 'recall');
  url.searchParams.set('recallThread', target.threadId);
  url.searchParams.set('recallInv', target.invocationId);
  if (target.catId) url.searchParams.set('recallCat', target.catId);
  else url.searchParams.delete('recallCat');
  window.history.pushState({ ...(window.history.state ?? {}), replyRecall: target.invocationId }, '', url);
}

/** Open the canonical Workspace memory surface and target this exact cat turn. */
export function openReplyRecallInWorkspace(target: ReplyRecallTarget): void {
  const chat = useChatStore.getState();
  chat.setWorkspaceMode('recall');
  writeReplyRecallTarget(target);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ReplyRecallTarget>(REPLY_RECALL_OPEN_EVENT, { detail: target }));
  }
}
