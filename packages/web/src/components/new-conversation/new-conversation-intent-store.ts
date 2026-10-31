import { type ContextAttachment, ContextAttachmentsSchema } from '@cat-cafe/shared';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { PendingNewConversationIntent } from './first-message-admission';

const DB_NAME = 'cat-cafe-new-conversation';
const DB_VERSION = 1;
const STORE = 'owner-intents';

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

let dbPromise: Promise<IDBPDatabase<NewConversationIntentDB>> | null = null;

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

function readFileBytes(file: File): Promise<ArrayBuffer> {
  const modern = file as File & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof modern.arrayBuffer === 'function') return modern.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('file read returned a non-binary result'));
    };
    reader.readAsArrayBuffer(file);
  });
}

function isStoredArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

export async function loadNewConversationIntent(ownerUserId: string): Promise<PersistedNewConversationIntent | null> {
  const record = await (await database()).get(STORE, ownerUserId);
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
}

export async function saveNewConversationIntent(value: PersistedNewConversationIntent): Promise<void> {
  if (!value.ownerUserId.trim() || !isIntent(value.intent)) throw new Error('invalid new-conversation intent');
  const parsedContext = ContextAttachmentsSchema.safeParse(value.contextAttachments);
  const files = await Promise.all(
    value.files.slice(0, 5).map(async (file) => ({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      bytes: await readFileBytes(file),
    })),
  );
  await (await database()).put(STORE, {
    ownerUserId: value.ownerUserId,
    intent: { ...value.intent, preferredCats: [...value.intent.preferredCats] },
    files,
    contextAttachments: parsedContext.success ? [...parsedContext.data] : [],
    updatedAt: value.updatedAt,
  });
}

export async function clearNewConversationIntent(ownerUserId: string): Promise<void> {
  await (await database()).delete(STORE, ownerUserId);
}

export function _resetNewConversationIntentDbForTests(): void {
  const current = dbPromise;
  dbPromise = null;
  void current?.then((db) => db.close());
}
