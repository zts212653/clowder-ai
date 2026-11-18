import { createBrowserUuid } from './browser-uuid';
import { resolveMessageElements } from './scrollToMessage';
import { kickTeleportResolve, type PendingTeleport, peekPendingTeleport, setPendingTeleport } from './teleport';

const STORAGE_KEY = 'cat-cafe:f310:pending-source-action:v1';
export interface EntrustedWorkMessageAction {
  threadId: string;
  messageId: string;
  blockId?: string;
}
export interface SourceActionRequest {
  requestId: string;
  blockId?: string;
}

type SourceRecord = EntrustedWorkMessageAction & { requestId?: string; retired?: boolean };
// The source slot has one latest request. Its terminal state also bars every older stored request.
let currentRequest: { requestId: string; state: 'active' | 'retired' | 'completed' } | undefined;

function readRecord(): SourceRecord | undefined {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('threadId' in raw) ||
      typeof raw.threadId !== 'string' ||
      !raw.threadId ||
      !('messageId' in raw) ||
      typeof raw.messageId !== 'string' ||
      !raw.messageId ||
      ('blockId' in raw && typeof raw.blockId !== 'string') ||
      ('requestId' in raw && (typeof raw.requestId !== 'string' || !raw.requestId)) ||
      ('retired' in raw && typeof raw.retired !== 'boolean')
    )
      return;
    return raw as SourceRecord;
  } catch {
    return undefined;
  }
}

export function __resetMessageSourceForTest(): void {
  currentRequest = undefined;
}

/** Retirement keeps the source coordinate, but it cannot replay as an active request. */
export function retireMessageSource(target: PendingTeleport): void {
  const source = target.sourceAction;
  if (!source || currentRequest?.requestId !== source.requestId || currentRequest.state !== 'active') return;
  currentRequest.state = 'retired';
  const stored = readRecord();
  if (stored?.requestId !== source.requestId) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, retired: true }));
  } catch {
    // Browser storage remains best-effort; cancellation itself is never prevented.
  }
}

/** The coordinate survives routing; the reading owner alone scrolls and settles it. */
export function retainMessageSource(coordinate: EntrustedWorkMessageAction): SourceActionRequest {
  const source = {
    requestId: createBrowserUuid(),
    ...(coordinate.blockId ? { blockId: coordinate.blockId } : {}),
  };
  currentRequest = { requestId: source.requestId, state: 'active' };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...coordinate, ...source }));
  } catch {
    // Same-page reading still works when session storage is unavailable.
  }
  return source;
}

export function resumeMessageSource(threadId: string): void {
  if (peekPendingTeleport(threadId)) return;
  const stored = readRecord();
  if (!stored || stored.threadId !== threadId || stored.retired) return;
  // Storage is a routing carrier, never a way to revive or replace this page's request.
  if (currentRequest && (currentRequest.requestId !== stored.requestId || currentRequest.state !== 'active')) return;
  const sourceAction = stored.requestId
    ? { requestId: stored.requestId, ...(stored.blockId ? { blockId: stored.blockId } : {}) }
    : retainMessageSource(stored);
  currentRequest ??= { requestId: sourceAction.requestId, state: 'active' };
  setPendingTeleport({ threadId, messageId: stored.messageId, sourceAction });
  kickTeleportResolve();
}

export function sourceMessageElement(root: ParentNode, messageId: string, blockId?: string): HTMLElement | undefined {
  const message = resolveMessageElements([messageId], root)[0];
  if (!blockId) return message;
  return (
    message &&
    [...message.querySelectorAll<HTMLElement>('[data-rich-block-id]')].find(
      (node) => node.dataset.richBlockId === blockId,
    )
  );
}

/** A successful exact owner receipt may focus the source, never scroll a second time. */
export function completeMessageSource(target: PendingTeleport, root: HTMLElement): void {
  const source = target.sourceAction;
  const current = currentRequest;
  if (!source || !current || current.requestId !== source.requestId || current.state !== 'active') return;
  const element = sourceMessageElement(root, target.messageId, source.blockId);
  if (!element) return;
  current.state = 'completed';
  try {
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
  } catch {
    // Presentation failure cannot turn the owner's exact receipt back into a live request.
  }
  if (currentRequest !== current || current.state !== 'completed') return;
  const stored = readRecord();
  if (currentRequest !== current || stored?.requestId !== source.requestId) return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // The completed in-memory request cannot replay if storage cleanup is denied.
  }
}
