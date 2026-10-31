import type { ContextAttachment } from '@cat-cafe/shared';

export interface ComposerDraftClientSnapshot {
  text: string;
  imageUrls?: string[];
  contextAttachments: ContextAttachment[];
  replyToId?: string;
  serverRevision?: number;
}

interface ComposerDraftFlushResult {
  persisted: boolean;
  revision: number;
  snapshot: ComposerDraftClientSnapshot;
  requiresConfirmation?: boolean;
  recoveryBlocked?: boolean;
}

interface ComposerDraftFlushOptions {
  admission: boolean;
}

type ComposerDraftFlusher = (options?: ComposerDraftFlushOptions) => Promise<ComposerDraftFlushResult>;

export interface ComposerDraftAdmissionTicket {
  threadId: string;
  expectedRevision: number;
}

export class ComposerDraftFlushError extends Error {
  constructor() {
    super('当前草稿尚未安全保存，已停止撤回；请重试');
    this.name = 'ComposerDraftFlushError';
  }
}

export class ComposerDraftConfirmationRequiredError extends Error {
  constructor() {
    super('已找回另一份未发送草稿；请检查合并后的内容，再次发送以确认');
    this.name = 'ComposerDraftConfirmationRequiredError';
  }
}

export class ComposerDraftRecoveryBlockedError extends Error {
  constructor() {
    super('已保存的附件尚未完整找回；请重试找回或明确移除后再发送');
    this.name = 'ComposerDraftRecoveryBlockedError';
  }
}

const flushers = new Map<string, ComposerDraftFlusher>();
const observations = new Map<string, () => { text: string; revision: number; ready: boolean } | null>();

export function registerComposerDraftFlusher(threadId: string, flusher: ComposerDraftFlusher): () => void {
  flushers.set(threadId, flusher);
  return () => {
    if (flushers.get(threadId) === flusher) flushers.delete(threadId);
  };
}

export function registerComposerDraftObserver(
  threadId: string,
  observe: () => { text: string; revision: number; ready: boolean } | null,
): () => void {
  observations.set(threadId, observe);
  return () => {
    if (observations.get(threadId) === observe) observations.delete(threadId);
  };
}

/** Read the mounted owner editor; this registry does not store another draft. */
export function observeComposerDraft(threadId: string) {
  return observations.get(threadId)?.() ?? null;
}

export async function flushComposerDraft(
  threadId: string,
  options?: { includeRevision: boolean },
): Promise<ComposerDraftClientSnapshot | null> {
  const flusher = flushers.get(threadId);
  if (!flusher) return null;
  const result = await flusher();
  if (!result.persisted) throw new ComposerDraftFlushError();
  return options?.includeRevision ? { ...result.snapshot, serverRevision: result.revision } : result.snapshot;
}

export async function prepareComposerDraftAdmission(threadId: string): Promise<ComposerDraftAdmissionTicket> {
  const flusher = flushers.get(threadId);
  if (!flusher) throw new ComposerDraftFlushError();
  const result = await flusher({ admission: true });
  if (result.recoveryBlocked) throw new ComposerDraftRecoveryBlockedError();
  if (!result.persisted) throw new ComposerDraftFlushError();
  if (result.requiresConfirmation) throw new ComposerDraftConfirmationRequiredError();
  return { threadId, expectedRevision: result.revision };
}
