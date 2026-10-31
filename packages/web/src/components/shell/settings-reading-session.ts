import { readChatReadingRef, releaseChatReadingRef } from '@/utils/chat-scroll-memory';
import { getSettingsReadingScope } from './settings-reading-scope';

export interface SettingsReadingSession {
  id: string;
  threadId: string;
  label: string;
  readingRef: string;
}

export const SETTINGS_READING_SESSION_KEY = 'cat-cafe:settings-source-return:v2';
export function settingsReadingSessionKey(scope = getSettingsReadingScope()): string {
  return `${SETTINGS_READING_SESSION_KEY}:${scope}`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048;
}

function parseSession(value: unknown): SettingsReadingSession | null {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    !identifier(value.threadId) ||
    !identifier(value.label) ||
    !identifier(value.readingRef) ||
    readChatReadingRef(value.readingRef)?.threadId !== value.threadId
  )
    return null;
  return { id: value.id, threadId: value.threadId, label: value.label, readingRef: value.readingRef };
}

/** Geometry and draft stay with their original owners; only this association is activated. */
export function startSettingsReadingSession(
  source: Omit<SettingsReadingSession, 'id'>,
  scope = getSettingsReadingScope(),
): {
  session: SettingsReadingSession;
  persisted: boolean;
} {
  const session = parseSession({ id: crypto.randomUUID(), ...source });
  if (!session) throw new Error('Invalid Settings reading source');
  const previous = readSettingsReadingSession(scope);
  let persisted = false;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        settingsReadingSessionKey(scope),
        JSON.stringify({ v: 2, session, attempted: false }),
      );
      persisted = true;
    } catch {
      // setItem is atomic: a failed activation must leave the old reachable association intact.
    }
  }
  if (persisted && previous && previous.readingRef !== session.readingRef)
    releaseChatReadingRef(previous.readingRef, previous.threadId);
  return { session, persisted };
}

function readState(scope: string): { session: SettingsReadingSession; attempted: boolean } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(settingsReadingSessionKey(scope));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!record(value) || value.v !== 2 || typeof value.attempted !== 'boolean') return null;
    const session = parseSession(value.session);
    return session ? { session, attempted: value.attempted } : null;
  } catch {
    return null;
  }
}

export function readSettingsReadingSession(scope = getSettingsReadingScope()): SettingsReadingSession | null {
  return readState(scope)?.session ?? null;
}

export function settingsReadingReturnAttempted(expectedId: string, scope = getSettingsReadingScope()): boolean {
  const active = readState(scope);
  return active?.session.id === expectedId && active.attempted;
}

/** Mark the explicit attempt before admission, so rejection and cancellation remain retryable after reload. */
export function markSettingsReadingReturnAttempted(expectedId: string, scope = getSettingsReadingScope()): boolean {
  const active = readState(scope);
  if (!active || active.session.id !== expectedId) return false;
  if (active.attempted) return true;
  try {
    window.localStorage.setItem(settingsReadingSessionKey(scope), JSON.stringify({ v: 2, ...active, attempted: true }));
    return true;
  } catch {
    return false;
  }
}

/** Association consumption and reading-owner retirement have distinct, honest outcomes. */
export function clearSettingsReadingSession(
  expectedId: string,
  scope = getSettingsReadingScope(),
): { cleared: boolean; referenceReleased: boolean } {
  const active = readSettingsReadingSession(scope);
  if (!active || active.id !== expectedId || typeof window === 'undefined')
    return { cleared: false, referenceReleased: false };
  try {
    window.localStorage.removeItem(settingsReadingSessionKey(scope));
  } catch {
    return { cleared: false, referenceReleased: false };
  }
  return { cleared: true, referenceReleased: releaseChatReadingRef(active.readingRef, active.threadId) };
}
