import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { ChatMessage, Thread } from '../stores/chat-types';

const DB_NAME = 'cat-cafe-offline';
/**
 * F183 Phase D AC-D1 — bump this when the bubble identity contract or
 * persisted record shape changes (e.g., ADR-033 stable-key reshuffle,
 * ChatMessage field semantics shift). The upgrade hook drops every existing
 * object store on bump — snapshots are not the source of truth (KD-1, KD-3),
 * so dropping is safe; next hydration rebuilds from API. NEVER decrement.
 */
const DB_VERSION = 3;
const MAX_SNAPSHOT_MESSAGES = 50;

/** F194 Phase Z10 AC-Z28: persist activeInvocations + hasActiveInvocation
 *  per thread so F5 first paint shows last-known active state. fetchQueue
 *  authoritative-refreshes after mount (overwrites with server truth). */
export interface PersistedThreadActiveState {
  hasActiveInvocation: boolean;
  activeInvocations: Record<string, { catId: string; mode: string; startedAt?: number }>;
}

interface CatCafeOfflineDB extends DBSchema {
  threads: {
    key: string;
    value: { id: string; threads: Thread[]; updatedAt: number };
  };
  'thread-messages': {
    key: string;
    value: {
      threadId: string;
      messages: ChatMessage[];
      hasMore: boolean;
      updatedAt: number;
    };
  };
  'thread-active-state': {
    key: string;
    value: {
      threadId: string;
      hasActiveInvocation: boolean;
      activeInvocations: PersistedThreadActiveState['activeInvocations'];
      updatedAt: number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<CatCafeOfflineDB>> | null = null;

function getDB(): Promise<IDBPDatabase<CatCafeOfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CatCafeOfflineDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // F183 Phase D AC-D1 — schema-version invalidation. When a client
        // with a prior DB_VERSION opens at the new version, drop every
        // pre-existing store so stale snapshots from the old contract are
        // gone. oldVersion === 0 = brand-new install, no stale data to drop.
        if (oldVersion > 0) {
          for (const name of Array.from(db.objectStoreNames)) {
            db.deleteObjectStore(name);
          }
        }
        if (!db.objectStoreNames.contains('threads')) {
          db.createObjectStore('threads', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('thread-messages')) {
          db.createObjectStore('thread-messages', { keyPath: 'threadId' });
        }
        // F194 Phase Z10 AC-Z28: persist activeInvocations across F5.
        if (!db.objectStoreNames.contains('thread-active-state')) {
          db.createObjectStore('thread-active-state', { keyPath: 'threadId' });
        }
      },
    });
  }
  return dbPromise;
}

export async function saveThreads(threads: Thread[]): Promise<void> {
  const db = await getDB();
  await db.put('threads', {
    id: 'thread-list',
    threads,
    updatedAt: Date.now(),
  });
}

export async function loadThreads(): Promise<Thread[] | null> {
  const db = await getDB();
  const record = await db.get('threads', 'thread-list');
  return record?.threads ?? null;
}

/**
 * F183 Phase D — strip the `cachedFrom` marker before persisting. The marker
 * is a per-load decoration that signals "this came from the IDB cache" to
 * the hydration merge layer; it must never round-trip into the snapshot or
 * the next load would re-stamp on top of an existing stamp (no harm, but
 * pollutes the persisted record).
 */
function stripPersistMarkers(m: ChatMessage): ChatMessage {
  if (m.cachedFrom === undefined) return m;
  const copy = { ...m };
  delete copy.cachedFrom;
  return copy;
}

export async function saveThreadMessages(threadId: string, messages: ChatMessage[], hasMore: boolean): Promise<void> {
  const db = await getDB();
  // Skip isStreaming placeholders — they're in-progress UI state, not durable history.
  // Persisting them causes ghost bubbles on reload when catInvocations is empty (F164 bug).
  const persistable = messages.filter((m) => !m.isStreaming).map(stripPersistMarkers);
  const trimmed = persistable.slice(-MAX_SNAPSHOT_MESSAGES);
  await db.put('thread-messages', {
    threadId,
    messages: trimmed,
    hasMore,
    updatedAt: Date.now(),
  });
}

export async function loadThreadMessages(
  threadId: string,
): Promise<{ messages: ChatMessage[]; hasMore: boolean; updatedAt: number } | null> {
  const db = await getDB();
  const record = await db.get('thread-messages', threadId);
  if (!record) return null;
  // Defense-in-depth for snapshots written by pre-fix clients that still contain
  // isStreaming placeholders OR a leaked `cachedFrom` marker (Phase D). Without
  // this, F5 with a failed API fetch (offline) would surface ghost bubbles that
  // the merge layer can no longer reconcile.
  const filtered = record.messages.filter((m) => !m.isStreaming).map(stripPersistMarkers);
  const dirty = filtered.length !== record.messages.length || record.messages.some((m) => m.cachedFrom !== undefined);
  if (dirty) {
    const cleaned = { ...record, messages: filtered, updatedAt: Date.now() };
    try {
      await db.put('thread-messages', cleaned);
    } catch {
      // Self-heal is best-effort; a future save or load will retry.
    }
    // F183 Phase D — stamp every returned message with cachedFrom='idb' so
    // hydration merge can drop them on history-replace without touching live state.
    return {
      messages: cleaned.messages.map((m) => ({ ...m, cachedFrom: 'idb' as const })),
      hasMore: cleaned.hasMore,
      updatedAt: cleaned.updatedAt,
    };
  }
  return {
    messages: record.messages.map((m) => ({ ...m, cachedFrom: 'idb' as const })),
    hasMore: record.hasMore,
    updatedAt: record.updatedAt,
  };
}

/**
 * F194 Phase Z10 AC-Z28 — save activeInvocations snapshot for F5 restore.
 * Called write-through whenever the in-memory store's active state changes
 * (typically from fetchQueue or socket activeInvocation events).
 */
export async function saveThreadActiveState(threadId: string, state: PersistedThreadActiveState): Promise<void> {
  const db = await getDB();
  await db.put('thread-active-state', {
    threadId,
    hasActiveInvocation: state.hasActiveInvocation,
    activeInvocations: state.activeInvocations,
    updatedAt: Date.now(),
  });
}

/**
 * F194 Phase Z10 AC-Z28 — load activeInvocations snapshot for F5 first paint.
 * useChatHistory restores this BEFORE fetchQueue fires async, so UI shows
 * last-known active state instead of fake "idle" gap (R14).
 */
export async function loadThreadActiveState(threadId: string): Promise<PersistedThreadActiveState | null> {
  const db = await getDB();
  const record = await db.get('thread-active-state', threadId);
  if (!record) return null;
  return {
    hasActiveInvocation: record.hasActiveInvocation,
    activeInvocations: record.activeInvocations,
  };
}

/** @internal — only for tests to inject faults */
export const _getDBForTest = getDB;

export async function clearAll(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['threads', 'thread-messages', 'thread-active-state'], 'readwrite');
  tx.objectStore('threads').clear();
  tx.objectStore('thread-messages').clear();
  tx.objectStore('thread-active-state').clear();
  await tx.done;
}

/** Reset the cached DB connection. Test-only. */
export function _resetDBForTest(): void {
  dbPromise = null;
}

/**
 * Close + reset the cached DB connection. Test-only. Use before
 * `idb.deleteDB(...)` so the delete request is not blocked by an open
 * connection (fake-indexeddb hangs forever otherwise).
 */
export async function _closeDBForTest(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}
