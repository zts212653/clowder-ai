import { releaseChatReadingRef } from '@/utils/chat-scroll-memory';
import { type MessageFindContext, parseMessageFindContext } from './message-find-state';
import { interruptMessageReadingTrip, type MessageReadingTrip } from './message-reading-trip';

export interface MessageReadingSession {
  id: string;
  originPersisted: boolean;
  trip: MessageReadingTrip;
  find?: MessageFindContext;
}

// Browser-local navigation metadata uses the existing browser persistence carrier.
// Geometry stays exclusively behind the original reading owner's opaque reference.
const PREFIX = 'cat-cafe:message-reading-session:';
const ACTIVE = 'cat-cafe:message-reading-active:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = ['ready', 'moving', 'unavailable', 'interrupted', 'completed'] as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048;
}

function boundedIndex(value: unknown, count: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < count;
}

function parsePending(value: unknown, count: number): MessageReadingTrip['pending'] | undefined {
  if (value === null) return null;
  if (!object(value)) return;
  if (value.kind === 'return') return { kind: 'return' };
  if (value.kind === 'target' && boundedIndex(value.index, count)) return { kind: 'target', index: value.index };
}

function parseTargets(value: unknown, allowEmpty: boolean): MessageReadingTrip['targets'] | null {
  if (!Array.isArray(value) || (!value.length && !allowEmpty) || value.length > 200) return null;
  const targets: MessageReadingTrip['targets'][number][] = [];
  for (const target of value) {
    if (!object(target) || !identifier(target.threadId) || !identifier(target.messageId)) return null;
    if (target.contentRevision !== undefined && !identifier(target.contentRevision)) return null;
    targets.push({
      threadId: target.threadId,
      messageId: target.messageId,
      ...(target.contentRevision !== undefined ? { contentRevision: target.contentRevision } : {}),
    });
  }
  return targets;
}

function parseTrip(value: unknown, allowEmpty = false): MessageReadingTrip | null {
  if (!object(value) || !identifier(value.searchId) || !object(value.origin)) return null;
  if (!identifier(value.origin.threadId) || !identifier(value.origin.readingRef)) return null;
  const targets = parseTargets(value.targets, allowEmpty);
  if (!targets) return null;
  if (
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    value.generation >= Number.MAX_SAFE_INTEGER
  )
    return null;
  if (value.settledIndex !== null && !boundedIndex(value.settledIndex, targets.length)) return null;
  if (typeof value.status !== 'string' || !STATUSES.some((status) => status === value.status)) return null;
  const pending = parsePending(value.pending, targets.length);
  if (pending === undefined || (value.status === 'moving') !== (pending !== null)) return null;
  return {
    searchId: value.searchId,
    origin: { threadId: value.origin.threadId, readingRef: value.origin.readingRef },
    targets,
    generation: value.generation,
    settledIndex: value.settledIndex,
    pending,
    status: value.status as MessageReadingTrip['status'],
  };
}

function parseSession(value: unknown): MessageReadingSession | null {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    typeof value.originPersisted !== 'boolean'
  )
    return null;
  const find = value.find === undefined ? undefined : parseMessageFindContext(value.find);
  if (find === null) return null;
  const trip = parseTrip(value.trip, find !== undefined);
  return trip ? { id: value.id, originPersisted: value.originPersisted, trip, ...(find ? { find } : {}) } : null;
}

export function startMessageReadingSession(
  trip: MessageReadingTrip,
  originPersisted: boolean,
  find?: MessageFindContext,
): {
  session: MessageReadingSession;
  persisted: boolean;
} {
  const findSnapshot = find ? parseMessageFindContext(find) : undefined;
  const snapshot = parseTrip(trip, !!findSnapshot);
  if (!snapshot || findSnapshot === null) throw new Error('Invalid reading trip coordinates');
  const session = {
    id: crypto.randomUUID(),
    trip: snapshot,
    originPersisted,
    ...(findSnapshot ? { find: findSnapshot } : {}),
  };
  let persisted = false;
  if (typeof window !== 'undefined') {
    let wroteRecord = false;
    try {
      window.localStorage.setItem(`${PREFIX}${session.id}`, JSON.stringify({ v: 1, session }));
      wroteRecord = true;
      window.localStorage.setItem(ACTIVE, session.id);
      persisted = true;
      retireUnreachableSessions(session);
    } catch {
      // Failed activation must preserve the previous reachable session.
      if (wroteRecord) {
        try {
          if (window.localStorage.getItem(ACTIVE) !== session.id)
            window.localStorage.removeItem(`${PREFIX}${session.id}`);
        } catch {
          /* Storage failure is reported; the previous active pointer is untouched. */
        }
      }
    }
  }
  return { session, persisted };
}

function retireUnreachableSessions(active: MessageReadingSession): void {
  const storage = window.localStorage;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(PREFIX) || key === `${PREFIX}${storage.getItem(ACTIVE)}`) continue;
    const raw = storage.getItem(key);
    let record: unknown = null;
    try {
      record = raw ? JSON.parse(raw) : null;
    } catch {
      /* Retire invalid private metadata without claiming its ref. */
    }
    const previous = object(record) && record.v === 1 ? parseSession(record.session) : null;
    if (
      previous &&
      key === `${PREFIX}${previous.id}` &&
      previous.trip.origin.readingRef !== active.trip.origin.readingRef
    )
      releaseChatReadingRef(previous.trip.origin.readingRef, previous.trip.origin.threadId);
    storage.removeItem(key);
  }
}

/** Updating an old session never changes which explicitly opened session is active. */
export function saveMessageReadingSession(session: MessageReadingSession): boolean {
  const snapshot = parseSession(session);
  if (!snapshot || typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem(ACTIVE) !== snapshot.id) return false;
    window.localStorage.setItem(`${PREFIX}${snapshot.id}`, JSON.stringify({ v: 1, session: snapshot }));
    return true;
  } catch {
    return false;
  }
}

export function readActiveMessageReadingSession(): MessageReadingSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const id = window.localStorage.getItem(ACTIVE);
    if (!id || !UUID.test(id)) return null;
    const raw = window.localStorage.getItem(`${PREFIX}${id}`);
    const record: unknown = raw ? JSON.parse(raw) : null;
    if (!object(record) || record.v !== 1) return null;
    const session = parseSession(record.session);
    if (!session || session.id !== id) return null;
    return session.trip.status === 'moving' ? { ...session, trip: interruptMessageReadingTrip(session.trip) } : session;
  } catch {
    return null;
  }
}
