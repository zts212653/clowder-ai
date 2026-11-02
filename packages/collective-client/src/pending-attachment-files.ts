import type { CollectiveMessageAttachment, MessageSticker } from '@cat-cafe/shared';
export interface PendingAttachmentFile {
  id: string;
  file: File;
  attachment?: CollectiveMessageAttachment;
  sticker?: MessageSticker;
}

interface FileIntent {
  id: string;
  attachmentId?: string;
}
const intentKey = (namespace: string) => `collective-file-intents:${namespace}`;
function fileIntents(namespace: string): FileIntent[] {
  const value: unknown = JSON.parse(localStorage.getItem(intentKey(namespace)) ?? '[]');
  return Array.isArray(value)
    ? value.filter(
        (item): item is FileIntent =>
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          (item.attachmentId === undefined || typeof item.attachmentId === 'string'),
      )
    : [];
}
/** Synchronous intent is authoritative across reload; the byte cache cannot recreate a removed draft item. */
export function beginPendingAttachmentFile(namespace: string, id: string) {
  const intents = fileIntents(namespace);
  if (!intents.some((item) => item.id === id))
    localStorage.setItem(intentKey(namespace), JSON.stringify([...intents, { id }]));
}
export function hasPendingAttachmentFile(namespace: string, id: string) {
  return fileIntents(namespace).some((item) => item.id === id);
}

/** Unsent files belong to this exact person/channel draft and persist until removal or its send ACK. */
async function openFiles() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('collective-private-attachment-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function pendingAttachmentFiles(namespace: string): Promise<PendingAttachmentFile[]> {
  const db = await openFiles();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as (PendingAttachmentFile & { namespace: string })[])
            .filter(
              (item) => item.namespace === namespace && fileIntents(namespace).some((intent) => intent.id === item.id),
            )
            .map(({ id, file, attachment, sticker }) => ({ id, file, attachment, sticker })),
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function discardPendingAttachmentFiles(namespace: string, attachmentIds: readonly string[]) {
  const ids = new Set(attachmentIds);
  const intents = fileIntents(namespace);
  const removed = intents.filter((item) => ids.has(item.id) || (item.attachmentId && ids.has(item.attachmentId)));
  // Persist removal before any await: navigation must not let an unfinished cache deletion restore this item.
  localStorage.setItem(intentKey(namespace), JSON.stringify(intents.filter((item) => !removed.includes(item))));
  if (!removed.length) return;
  const db = await openFiles();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      for (const item of removed) transaction.objectStore('files').delete(`${namespace}:${item.id}`);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
export async function savePendingAttachmentFile(namespace: string, item: PendingAttachmentFile) {
  const intents = fileIntents(namespace);
  if (!intents.some((intent) => intent.id === item.id)) return;
  if (item.attachment)
    localStorage.setItem(
      intentKey(namespace),
      JSON.stringify(
        intents.map((intent) =>
          intent.id === item.id ? { ...intent, attachmentId: item.attachment!.attachmentId } : intent,
        ),
      ),
    );
  const db = await openFiles();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      transaction.objectStore('files').put({ key: `${namespace}:${item.id}`, namespace, ...item });
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
