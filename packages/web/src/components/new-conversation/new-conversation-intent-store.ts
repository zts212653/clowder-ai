import { type ContextAttachment, ContextAttachmentsSchema } from '@cat-cafe/shared';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { PendingNewConversationIntent } from './first-message-admission';

const DB_NAME = 'cat-cafe-new-conversation';
const DB_VERSION = 1;
const STORE = 'owner-intents';

export type NewConversationIntentSaveState = 'idle' | 'saving' | 'failed' | 'cancelled';

export interface PersistedNewConversationIntent {
  ownerUserId: string;
  intent: PendingNewConversationIntent;
  files: File[];
  contextAttachments: ContextAttachment[];
  updatedAt: number;
}

interface NewConversationIntentDB extends DBSchema {
  'owner-intents': {
    key: string;
    value: StoredNewConversationIntent;
  };
}

interface StoredFile {
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
}

interface StoredNewConversationIntent extends Omit<PersistedNewConversationIntent, 'files'> {
  files: StoredFile[];
}

type PendingSaveStatus = Exclude<NewConversationIntentSaveState, 'idle'>;
type PendingSavePhase = 'reading' | 'queued' | 'writing' | 'settled';

interface PendingSave {
  value: PersistedNewConversationIntent;
  status: PendingSaveStatus;
  phase: PendingSavePhase;
  /** A clear owns the row; load waits for the delete instead of returning this snapshot. */
  clearing: boolean;
  controller: AbortController;
  /** Settles the caller without waiting for a queued commit op behind an earlier write. */
  rejectCancellation?: (error: Error) => void;
  promise: Promise<void>;
}

let dbPromise: Promise<IDBPDatabase<NewConversationIntentDB>> | null = null;
const ownerOperations = new Map<string, Promise<unknown>>();
const pendingSaves = new Map<string, PendingSave>();
/** What this tab last wrote per owner; composer keystrokes repeat it because text is not stored here. */
const committedSaves = new Map<string, PersistedNewConversationIntent>();
const saveStateListeners = new Map<string, Set<() => void>>();

/**
 * Keep database reads, writes and clears ordered per owner. Deliberately does
 * not hold file-byte reads: a read that never settles must not block the queue.
 */
function enqueueOwnerOperation<T>(ownerUserId: string, operation: () => Promise<T>): Promise<T> {
  const next = (ownerOperations.get(ownerUserId) ?? Promise.resolve()).then(operation, operation);
  ownerOperations.set(ownerUserId, next);
  const release = () => {
    if (ownerOperations.get(ownerUserId) === next) ownerOperations.delete(ownerUserId);
  };
  void next.then(release, release);
  return next;
}

function database(): Promise<IDBPDatabase<NewConversationIntentDB>> {
  if (!dbPromise) {
    dbPromise = openDB<NewConversationIntentDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'ownerUserId' });
      },
    });
  }
  return dbPromise;
}

function isIntent(value: unknown): value is PendingNewConversationIntent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PendingNewConversationIntent>;
  return (
    candidate.v === 1 &&
    typeof candidate.createIdempotencyKey === 'string' &&
    typeof candidate.messageIdempotencyKey === 'string' &&
    typeof candidate.creationStarted === 'boolean' &&
    Array.isArray(candidate.preferredCats) &&
    candidate.preferredCats.every((catId) => typeof catId === 'string') &&
    (candidate.projectPath === undefined || typeof candidate.projectPath === 'string') &&
    (candidate.title === undefined || (typeof candidate.title === 'string' && candidate.title.length <= 200)) &&
    (candidate.pinned === undefined || typeof candidate.pinned === 'boolean') &&
    (candidate.createdThreadId === undefined || typeof candidate.createdThreadId === 'string') &&
    (candidate.messageAccepted === undefined || typeof candidate.messageAccepted === 'boolean') &&
    (candidate.composerDraftAdmission === undefined ||
      (candidate.composerDraftAdmission.threadId === 'default' &&
        Number.isSafeInteger(candidate.composerDraftAdmission.expectedRevision) &&
        candidate.composerDraftAdmission.expectedRevision >= 0)) &&
    (!candidate.messageAccepted || typeof candidate.createdThreadId === 'string')
  );
}

function abortError(): Error {
  const error = new Error('New-conversation draft save cancelled');
  error.name = 'AbortError';
  return error;
}

function normalizeValue(value: PersistedNewConversationIntent): PersistedNewConversationIntent {
  const parsedContext = ContextAttachmentsSchema.safeParse(value.contextAttachments);
  return {
    ownerUserId: value.ownerUserId,
    intent: { ...value.intent, preferredCats: [...value.intent.preferredCats] },
    files: value.files.slice(0, 5),
    contextAttachments: parsedContext.success ? [...parsedContext.data] : [],
    updatedAt: value.updatedAt,
  };
}

function copyValue(value: PersistedNewConversationIntent): PersistedNewConversationIntent {
  return {
    ownerUserId: value.ownerUserId,
    intent: { ...value.intent, preferredCats: [...value.intent.preferredCats] },
    files: [...value.files],
    contextAttachments: [...value.contextAttachments],
    updatedAt: value.updatedAt,
  };
}

/** Stable enough for the normalized intent/context shapes; updatedAt is never compared. */
function sameSnapshot(left: PersistedNewConversationIntent, right: PersistedNewConversationIntent): boolean {
  return (
    left.files.length === right.files.length &&
    left.files.every((file, index) => file === right.files[index]) &&
    JSON.stringify(left.intent) === JSON.stringify(right.intent) &&
    JSON.stringify(left.contextAttachments) === JSON.stringify(right.contextAttachments)
  );
}

function notifySaveState(ownerUserId: string): void {
  const listeners = saveStateListeners.get(ownerUserId);
  if (!listeners) return;
  [...listeners].forEach((listener) => {
    listener();
  });
}

function readFileBytes(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  if (signal.aborted) return Promise.reject(abortError());
  const modern = file as File & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof modern.arrayBuffer === 'function') {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      modern.arrayBuffer().then(
        (bytes) => {
          signal.removeEventListener('abort', onAbort);
          resolve(bytes);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    function cleanup() {
      signal.removeEventListener('abort', onAbort);
    }
    function onAbort() {
      cleanup();
      reader.abort();
      reject(abortError());
    }
    signal.addEventListener('abort', onAbort, { once: true });
    reader.onerror = () => {
      cleanup();
      reject(signal.aborted ? abortError() : (reader.error ?? new Error('file read failed')));
    };
    reader.onabort = () => {
      cleanup();
      reject(abortError());
    };
    reader.onload = () => {
      cleanup();
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('file read returned a non-binary result'));
    };
    reader.readAsArrayBuffer(file);
  });
}

function isStoredArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

async function runAttempt(attempt: PendingSave): Promise<void> {
  const ownerUserId = attempt.value.ownerUserId;
  try {
    const files = await Promise.all(
      attempt.value.files.map(async (file) => ({
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        bytes: await readFileBytes(file, attempt.controller.signal),
      })),
    );
    if (attempt.controller.signal.aborted || pendingSaves.get(ownerUserId) !== attempt) throw abortError();
    attempt.phase = 'queued';
    await enqueueOwnerOperation(ownerUserId, async () => {
      if (
        attempt.controller.signal.aborted ||
        pendingSaves.get(ownerUserId) !== attempt ||
        attempt.status !== 'saving'
      ) {
        throw abortError();
      }
      attempt.phase = 'writing';
      notifySaveState(ownerUserId);
      await (await database()).put(STORE, {
        ownerUserId: attempt.value.ownerUserId,
        intent: { ...attempt.value.intent, preferredCats: [...attempt.value.intent.preferredCats] },
        files,
        contextAttachments: [...attempt.value.contextAttachments],
        updatedAt: attempt.value.updatedAt,
      });
      committedSaves.set(ownerUserId, attempt.value);
    });
    attempt.phase = 'settled';
    if (pendingSaves.get(ownerUserId) === attempt && attempt.status === 'saving') {
      pendingSaves.delete(ownerUserId);
      notifySaveState(ownerUserId);
    }
  } catch (error) {
    attempt.phase = 'settled';
    if (attempt.controller.signal.aborted) {
      if (pendingSaves.get(ownerUserId) === attempt) {
        attempt.status = 'cancelled';
        notifySaveState(ownerUserId);
      }
      throw abortError();
    }
    if (pendingSaves.get(ownerUserId) === attempt && attempt.status === 'saving') {
      attempt.status = 'failed';
      notifySaveState(ownerUserId);
    }
    throw error;
  }
}

function startSave(value: PersistedNewConversationIntent, force: boolean): Promise<void> {
  if (!value.ownerUserId.trim() || !isIntent(value.intent)) {
    return Promise.reject(new Error('invalid new-conversation intent'));
  }
  const normalized = normalizeValue(value);
  const ownerUserId = normalized.ownerUserId;
  const existing = pendingSaves.get(ownerUserId);
  if (!force && existing && !existing.clearing && sameSnapshot(existing.value, normalized)) return existing.promise;
  const committed = committedSaves.get(ownerUserId);
  if (!force && !existing && committed && sameSnapshot(committed, normalized)) return Promise.resolve();
  if (existing && (existing.phase === 'reading' || existing.phase === 'queued')) {
    existing.status = 'cancelled';
    existing.controller.abort();
  }
  const attempt: PendingSave = {
    value: normalized,
    status: 'saving',
    phase: 'reading',
    clearing: false,
    controller: new AbortController(),
    promise: Promise.resolve(),
  };
  pendingSaves.set(ownerUserId, attempt);
  const cancellation = new Promise<never>((_, reject) => {
    attempt.rejectCancellation = reject;
  });
  const promise = Promise.race([runAttempt(attempt), cancellation]);
  attempt.promise = promise;
  notifySaveState(ownerUserId);
  return promise;
}

export function loadNewConversationIntent(ownerUserId: string): Promise<PersistedNewConversationIntent | null> {
  const pending = pendingSaves.get(ownerUserId);
  if (pending && !pending.clearing) return Promise.resolve(copyValue(pending.value));
  return enqueueOwnerOperation(ownerUserId, async () => {
    const current = pendingSaves.get(ownerUserId);
    if (current && !current.clearing) return copyValue(current.value);
    const record = await (await database()).get(STORE, ownerUserId);
    const currentAfterRead = pendingSaves.get(ownerUserId);
    if (currentAfterRead && !currentAfterRead.clearing) return copyValue(currentAfterRead.value);
    if (!record || record.ownerUserId !== ownerUserId || !isIntent(record.intent)) return null;
    const parsedContext = ContextAttachmentsSchema.safeParse(record.contextAttachments);
    return {
      ownerUserId,
      intent: {
        ...record.intent,
        preferredCats: [...record.intent.preferredCats],
      },
      files: Array.isArray(record.files)
        ? record.files
            .slice(0, 5)
            .filter(
              (file): file is StoredFile =>
                !!file &&
                typeof file.name === 'string' &&
                typeof file.type === 'string' &&
                typeof file.lastModified === 'number' &&
                isStoredArrayBuffer(file.bytes),
            )
            .map(
              (file) =>
                new File([file.bytes], file.name, {
                  type: file.type,
                  lastModified: file.lastModified,
                }),
            )
        : [],
      contextAttachments: parsedContext.success ? [...parsedContext.data] : [],
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    };
  });
}

export async function saveNewConversationIntent(value: PersistedNewConversationIntent): Promise<void> {
  return startSave(value, false);
}

export async function clearNewConversationIntent(ownerUserId: string): Promise<void> {
  // Saves issued from here on must rewrite the row this clear removes.
  committedSaves.delete(ownerUserId);
  const existing = pendingSaves.get(ownerUserId);
  if (existing) {
    existing.clearing = true;
    if (existing.status === 'saving') {
      existing.status = 'cancelled';
      if (existing.phase === 'reading' || existing.phase === 'queued') existing.controller.abort();
      notifySaveState(ownerUserId);
    }
  }
  await enqueueOwnerOperation(ownerUserId, async () => {
    try {
      await (await database()).delete(STORE, ownerUserId);
      // A write already running when the clear began lands first and records itself.
      committedSaves.delete(ownerUserId);
    } catch (error) {
      if (existing && pendingSaves.get(ownerUserId) === existing) {
        existing.clearing = false;
        existing.status = 'failed';
        notifySaveState(ownerUserId);
      }
      throw error;
    }
    if (existing && pendingSaves.get(ownerUserId) === existing) {
      pendingSaves.delete(ownerUserId);
      notifySaveState(ownerUserId);
    }
  });
}

export function getNewConversationIntentSaveState(ownerUserId: string | null): NewConversationIntentSaveState {
  if (!ownerUserId) return 'idle';
  return pendingSaves.get(ownerUserId)?.status ?? 'idle';
}

export function subscribeNewConversationIntentSaveState(ownerUserId: string, listener: () => void): () => void {
  let listeners = saveStateListeners.get(ownerUserId);
  if (!listeners) {
    listeners = new Set();
    saveStateListeners.set(ownerUserId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = saveStateListeners.get(ownerUserId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) saveStateListeners.delete(ownerUserId);
  };
}

export function canCancelNewConversationIntentSave(ownerUserId: string | null): boolean {
  if (!ownerUserId) return false;
  const attempt = pendingSaves.get(ownerUserId);
  if (!attempt || attempt.status !== 'saving' || attempt.clearing) return false;
  return attempt.phase === 'reading' || attempt.phase === 'queued';
}

export function cancelNewConversationIntentSave(ownerUserId: string): void {
  const attempt = pendingSaves.get(ownerUserId);
  if (!attempt || attempt.status !== 'saving' || attempt.clearing) return;
  if (attempt.phase === 'writing' || attempt.phase === 'settled') return;
  attempt.status = 'cancelled';
  attempt.controller.abort();
  attempt.rejectCancellation?.(abortError());
  notifySaveState(ownerUserId);
}

export async function retryNewConversationIntentSave(ownerUserId: string): Promise<void> {
  const attempt = pendingSaves.get(ownerUserId);
  if (!attempt || attempt.clearing) return;
  if (attempt.status === 'saving') {
    await attempt.promise;
    return;
  }
  await startSave(attempt.value, true);
}

export function _resetNewConversationIntentDbForTests(): void {
  pendingSaves.forEach((attempt) => {
    attempt.controller.abort();
  });
  pendingSaves.clear();
  committedSaves.clear();
  saveStateListeners.clear();
  const current = dbPromise;
  dbPromise = null;
  void current?.then((db) => db.close());
}
