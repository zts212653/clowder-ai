import type { ContextAttachment, MessageContent, MessageWorkDisposition } from '@cat-cafe/shared';
import { type DBSchema, openDB } from 'idb';

export interface SendAttempt {
  id: string;
  ownerUserId: string;
  threadId: string;
  content: string;
  files: File[];
  timestamp: number;
  status:
    | 'preparing'
    | 'sending'
    | 'accepted'
    | 'unknown'
    | 'checking'
    | 'failed'
    | 'delivered'
    | 'canceled'
    | 'recalled';
  retryable?: boolean;
  removed?: boolean;
  replyTo?: string;
  contextAttachments?: ContextAttachment[];
  explicitTargetCats?: string[];
  whisper?: { visibility: 'whisper'; whisperTo: string[] };
  messageDisposition?: MessageWorkDisposition;
  composerDraftRevision?: number;
  /** Present only while a failed local save has left its snapshot in the native composer. */
  composerDraftText?: string;
  confirmedTargetCats?: string[];
  serverMessageId?: string;
  contentBlocks?: MessageContent[];
  error?: string;
  persistenceError?: boolean;
  /** Browser-only object URLs, never stored as durable media references. */
  previewUrls?: string[];
}
interface StoredAttempt extends Omit<SendAttempt, 'files' | 'previewUrls'> {
  files: { name: string; type: string; lastModified: number; bytes: ArrayBuffer }[];
}
interface AttemptDB extends DBSchema {
  attempts: { key: [string, string, string]; value: StoredAttempt; indexes: { thread: [string, string] } };
}
let database: ReturnType<typeof openDB<AttemptDB>> | undefined;
function db() {
  database ??= openDB<AttemptDB>('cat-cafe-send-attempts', 1, {
    upgrade(value) {
      value
        .createObjectStore('attempts', { keyPath: ['ownerUserId', 'threadId', 'id'] })
        .createIndex('thread', ['ownerUserId', 'threadId']);
    },
  });
  return database;
}
function fileBytes(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('附件未能保存'));
    reader.onload = () =>
      reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('附件未能保存'));
    reader.readAsArrayBuffer(file);
  });
}
export async function saveSendAttempt(attempt: SendAttempt) {
  const { files, previewUrls: _previewUrls, ...record } = attempt;
  void _previewUrls;
  const stored = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      bytes: await fileBytes(file),
    })),
  );
  await (await db()).put('attempts', { ...record, files: stored });
}
export async function updateStoredSendAttempt(attempt: SendAttempt) {
  const { files: _files, previewUrls: _previewUrls, ...metadata } = attempt;
  void _files;
  void _previewUrls;
  const transaction = (await db()).transaction('attempts', 'readwrite');
  const prior = await transaction.store.get([attempt.ownerUserId, attempt.threadId, attempt.id]);
  if (prior) await transaction.store.put({ ...prior, ...metadata });
  await transaction.done;
}
export async function loadSendAttempts(ownerUserId: string, threadId: string): Promise<SendAttempt[]> {
  const records = await (await db()).getAllFromIndex('attempts', 'thread', [ownerUserId, threadId]);
  return records.map((record) => ({
    ...record,
    status: ['preparing', 'sending', 'checking'].includes(record.status) ? 'unknown' : record.status,
    files: record.files.map(
      (file) => new File([file.bytes], file.name, { type: file.type, lastModified: file.lastModified }),
    ),
  }));
}
export async function deleteSendAttempt(attempt: SendAttempt) {
  await (await db()).delete('attempts', [attempt.ownerUserId, attempt.threadId, attempt.id]);
}
