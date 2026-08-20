import type { ContextAttachment } from '@cat-cafe/shared';

export interface ComposerDraftClientSnapshot {
  text: string;
  contextAttachments: ContextAttachment[];
  replyToId?: string;
}

interface ComposerDraftFlushResult {
  persisted: boolean;
  snapshot: ComposerDraftClientSnapshot;
}

type ComposerDraftFlusher = () => Promise<ComposerDraftFlushResult>;

export class ComposerDraftFlushError extends Error {
  constructor() {
    super('当前草稿尚未安全保存，已停止撤回；请重试');
    this.name = 'ComposerDraftFlushError';
  }
}

const flushers = new Map<string, ComposerDraftFlusher>();

export function registerComposerDraftFlusher(threadId: string, flusher: ComposerDraftFlusher): () => void {
  flushers.set(threadId, flusher);
  return () => {
    if (flushers.get(threadId) === flusher) flushers.delete(threadId);
  };
}

export async function flushComposerDraft(threadId: string): Promise<ComposerDraftClientSnapshot | null> {
  const flusher = flushers.get(threadId);
  if (!flusher) return null;
  const result = await flusher();
  if (!result.persisted) throw new ComposerDraftFlushError();
  return result.snapshot;
}
