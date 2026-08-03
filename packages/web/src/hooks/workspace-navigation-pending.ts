import type { NavigateEvent } from '@/hooks/useWorkspaceNavigate';

const STORAGE_KEY = 'cat-cafe:pending-workspace-navigation:v1';

export interface WorkspaceNavigationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type WorkspaceNavigationReceiptReason =
  | 'thread_inactive'
  | 'non_chat_route'
  | 'narrow_viewport'
  | 'presentation_lock'
  | 'persistence_unavailable';

export interface WorkspaceNavigationReceipt {
  status: 'applied' | 'queued' | 'blocked';
  eventId: string;
  reason?: WorkspaceNavigationReceiptReason;
}

interface PendingWorkspaceNavigationState {
  version: 1;
  byThread: Record<string, NavigateEvent>;
}

function emptyState(): PendingWorkspaceNavigationState {
  return { version: 1, byThread: {} };
}

function isNavigateEvent(value: unknown): value is NavigateEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<NavigateEvent>;
  return (
    typeof event.path === 'string' &&
    (event.action === undefined ||
      event.action === 'open' ||
      event.action === 'reveal' ||
      event.action === 'knowledge-feed') &&
    (event.threadId === undefined || typeof event.threadId === 'string') &&
    (event.eventId === undefined || typeof event.eventId === 'string')
  );
}

function readState(storage: WorkspaceNavigationStorage): PendingWorkspaceNavigationState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<PendingWorkspaceNavigationState>;
    if (parsed.version !== 1 || !parsed.byThread || typeof parsed.byThread !== 'object') return emptyState();
    const byThread = Object.fromEntries(
      Object.entries(parsed.byThread).filter((entry): entry is [string, NavigateEvent] => isNavigateEvent(entry[1])),
    );
    return { version: 1, byThread };
  } catch {
    return emptyState();
  }
}

function writeState(storage: WorkspaceNavigationStorage, state: PendingWorkspaceNavigationState): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function isBlockedByPresentationLock(data: NavigateEvent, presentationLocked: boolean): boolean {
  return presentationLocked && data.action !== 'knowledge-feed';
}

export function queuePendingWorkspaceNavigation(storage: WorkspaceNavigationStorage, data: NavigateEvent): boolean {
  if (!data.threadId) return false;
  const state = readState(storage);
  state.byThread[data.threadId] = data;
  return writeState(storage, state);
}

export function getPendingWorkspaceNavigation(
  storage: WorkspaceNavigationStorage,
  threadId: string,
): NavigateEvent | null {
  return readState(storage).byThread[threadId] ?? null;
}

export function clearPendingWorkspaceNavigation(
  storage: WorkspaceNavigationStorage,
  threadId: string,
  eventId: string | undefined,
): void {
  const state = readState(storage);
  const pending = state.byThread[threadId];
  if (!pending || pending.eventId !== eventId) return;
  delete state.byThread[threadId];
  writeState(storage, state);
}

export function deliverWorkspaceNavigateEvent(input: {
  data: NavigateEvent;
  activeThreadId: string | null;
  isChatRoute: boolean;
  isWorkspaceVisible: boolean;
  presentationLocked: boolean;
  apply: (data: NavigateEvent) => boolean;
  persist: (data: NavigateEvent) => boolean;
}): WorkspaceNavigationReceipt {
  const { data } = input;
  const eventId = data.eventId ?? '';
  if (isBlockedByPresentationLock(data, input.presentationLocked)) {
    return { status: 'blocked', eventId, reason: 'presentation_lock' };
  }

  let queueReason: Extract<WorkspaceNavigationReceiptReason, 'thread_inactive' | 'non_chat_route' | 'narrow_viewport'>;
  if (!input.isChatRoute) {
    queueReason = 'non_chat_route';
  } else if (data.threadId && data.threadId !== input.activeThreadId) {
    queueReason = 'thread_inactive';
  } else if (!input.isWorkspaceVisible) {
    queueReason = 'narrow_viewport';
  } else {
    return input.apply(data) ? { status: 'applied', eventId } : { status: 'blocked', eventId };
  }

  if (!input.persist(data)) {
    return { status: 'blocked', eventId, reason: 'persistence_unavailable' };
  }
  return { status: 'queued', eventId, reason: queueReason };
}

export function consumePendingWorkspaceNavigation(input: {
  storage: WorkspaceNavigationStorage;
  threadId: string;
  canDisplay: boolean;
  presentationLocked: boolean;
  apply: (data: NavigateEvent) => boolean;
}): boolean {
  if (!input.canDisplay) return false;
  const pending = getPendingWorkspaceNavigation(input.storage, input.threadId);
  if (!pending || isBlockedByPresentationLock(pending, input.presentationLocked) || !input.apply(pending)) return false;
  clearPendingWorkspaceNavigation(input.storage, input.threadId, pending.eventId);
  return true;
}
