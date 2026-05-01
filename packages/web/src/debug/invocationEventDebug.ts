import {
  clearPersistedDebugFlag,
  clearStorageKey,
  type DebugStorageEntry,
  type DebugStorageKind,
  getDebugStorages,
  isRecord,
  parseBooleanString,
  persistDebugConfig,
  safeReadStorage,
} from './invocationEventDebug.storage';
import type {
  AllowedEventKey,
  DebugConfigureInput,
  DebugDumpOptions,
  DebugDumpResult,
  DebugEventInput,
  DebugStatus,
  DebugWindowApi,
  StoredDebugEvent,
} from './invocationEventDebug.types';
import { EVENT_KEYS } from './invocationEventDebug.types';

const DEFAULT_SIZE = 200;
const MIN_SIZE = 50;
const MAX_SIZE = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const STORAGE_KEY = 'cat-cafe:debug:ring-buffer';

declare global {
  interface Window {
    __catCafeDebug?: DebugWindowApi;
  }
}

let enabled = false;
let maxSize = DEFAULT_SIZE;
let expiresAt: number | null = null;
let records: StoredDebugEvent[] = [];
let ttlTimer: ReturnType<typeof setTimeout> | null = null;
let persistScope: DebugStorageKind | 'auto' = 'auto';

function clampSize(input?: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_SIZE;
  if (input < MIN_SIZE) return MIN_SIZE;
  if (input > MAX_SIZE) return MAX_SIZE;
  return Math.floor(input);
}

function normalizeTtlMs(input?: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return DEFAULT_TTL_MS;
  return Math.floor(input);
}

function trimToSize() {
  if (records.length <= maxSize) return;
  records = records.slice(records.length - maxSize);
}

function clearTtlTimer() {
  if (!ttlTimer) return;
  clearTimeout(ttlTimer);
  ttlTimer = null;
}

function removeWindowApi() {
  if (typeof window === 'undefined') return;
  if (!window.__catCafeDebug) return;
  delete window.__catCafeDebug;
}

function resetToDisabled() {
  enabled = false;
  maxSize = DEFAULT_SIZE;
  expiresAt = null;
  records = [];
  persistScope = 'auto';
  clearTtlTimer();
  clearPersistedDebugFlag(STORAGE_KEY);
  removeWindowApi();
}

function refreshTtl(ttlMs: number) {
  clearTtlTimer();
  expiresAt = Date.now() + ttlMs;
  ttlTimer = setTimeout(() => {
    resetToDisabled();
  }, ttlMs);
}

function sanitizeEvent(input: DebugEventInput): StoredDebugEvent {
  const source = input as Record<string, unknown>;
  const out: Partial<StoredDebugEvent> = {
    event: input.event,
    timestamp: typeof input.timestamp === 'number' ? input.timestamp : Date.now(),
  };

  for (const key of EVENT_KEYS) {
    if (key === 'event' || key === 'timestamp') continue;
    const value = source[key as AllowedEventKey];
    if (value === undefined) continue;

    if (key === 'queueStatuses' && Array.isArray(value)) {
      out.queueStatuses = value.filter((v): v is string => typeof v === 'string').slice(0, 32);
      continue;
    }

    if (key === 'origin' && (value === 'stream' || value === 'callback' || value === 'briefing')) {
      out.origin = value;
      continue;
    }

    if (
      (key === 'threadId' ||
        key === 'action' ||
        key === 'mode' ||
        key === 'reason' ||
        key === 'routeThreadId' ||
        key === 'storeThreadId' ||
        key === 'catId' ||
        key === 'actorId' ||
        key === 'messageId' ||
        key === 'existingMessageId' ||
        key === 'incomingMessageId' ||
        key === 'invocationId' ||
        key === 'canonicalInvocationId' ||
        key === 'bubbleKind' ||
        key === 'eventType' ||
        key === 'originPhase' ||
        key === 'sourcePath' ||
        key === 'recoveryAction' ||
        key === 'violationKind') &&
      typeof value === 'string'
    ) {
      out[key] = value;
      continue;
    }

    if ((key === 'existingMessageId' || key === 'incomingMessageId') && value === null) {
      out[key] = null;
      continue;
    }

    if ((key === 'queueLength' || key === 'seq') && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
      continue;
    }

    if (key === 'seq' && value === null) {
      out.seq = null;
      continue;
    }

    if (key === 'level' && (value === 'warn' || value === 'error')) {
      out.level = value;
      continue;
    }

    if ((key === 'isFinal' || key === 'queuePaused' || key === 'hasActiveInvocation') && typeof value === 'boolean') {
      out[key] = value;
    }
  }

  return out as StoredDebugEvent;
}

function hashThreadId(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function maskEvent(event: StoredDebugEvent): StoredDebugEvent {
  const masked: StoredDebugEvent = { ...event };
  if (masked.threadId) masked.threadId = hashThreadId(masked.threadId);
  if (masked.routeThreadId) masked.routeThreadId = hashThreadId(masked.routeThreadId);
  if (masked.storeThreadId) masked.storeThreadId = hashThreadId(masked.storeThreadId);
  return masked;
}

function cloneEvent(event: StoredDebugEvent): StoredDebugEvent {
  const copy: StoredDebugEvent = { ...event };
  if (Array.isArray(event.queueStatuses)) {
    copy.queueStatuses = [...event.queueStatuses];
  }
  return copy;
}

function makeDumpEvents(rawThreadId: boolean): StoredDebugEvent[] {
  const copy = records.map((item) => cloneEvent(item));
  if (rawThreadId) return copy;
  return copy.map(maskEvent);
}

function makeDumpResult(events: StoredDebugEvent[], rawThreadId: boolean): DebugDumpResult {
  return {
    meta: {
      generatedAt: Date.now(),
      count: events.length,
      enabled,
      size: maxSize,
      rawThreadId,
      marker: rawThreadId ? 'RAW' : 'MASKED',
      expiresAt,
    },
    events,
  };
}

export function configureDebug(input: DebugConfigureInput): DebugStatus {
  if (input.enabled === false) {
    resetToDisabled();
    return getDebugStatus();
  }

  if (input.enabled === true) {
    enabled = true;
  }

  maxSize = clampSize(input.size ?? maxSize);
  trimToSize();

  if (enabled) {
    const normalizedTtl = normalizeTtlMs(input.ttlMs);
    refreshTtl(normalizedTtl);
    if (expiresAt !== null) {
      persistDebugConfig(
        STORAGE_KEY,
        {
          enabled: true,
          size: maxSize,
          ttlMs: normalizedTtl,
          expiresAt,
        },
        persistScope,
      );
    }
  }

  return getDebugStatus();
}

export function recordDebugEvent(input: DebugEventInput) {
  if (!enabled) return;
  records.push(sanitizeEvent(input));
  trimToSize();
}

export function clearDebugEvents() {
  records = [];
}

export function dumpDebugEvents(options: DebugDumpOptions = {}): DebugDumpResult {
  const rawThreadId = options.rawThreadId === true;
  return makeDumpResult(makeDumpEvents(rawThreadId), rawThreadId);
}

export function dumpBubbleTimeline(options: DebugDumpOptions = {}): DebugDumpResult {
  const rawThreadId = options.rawThreadId === true;
  const events = makeDumpEvents(rawThreadId).filter(
    (item) => item.event === 'bubble_lifecycle' || item.event === 'bubble_invariant_violation',
  );
  return makeDumpResult(events, rawThreadId);
}

export function getDebugStatus(): DebugStatus {
  const ttlMsRemaining = expiresAt === null ? null : Math.max(0, expiresAt - Date.now());
  return {
    enabled,
    size: maxSize,
    count: records.length,
    expiresAt,
    ttlMsRemaining,
  };
}

export function isDebugEnabled(): boolean {
  return enabled;
}

export function ensureWindowDebugApi() {
  if (typeof window === 'undefined') return;
  if (!enabled) return;
  if (window.__catCafeDebug) return;

  window.__catCafeDebug = {
    configure: (input: DebugConfigureInput) => {
      const status = configureDebug(input);
      if (!status.enabled) {
        removeWindowApi();
      } else {
        ensureWindowDebugApi();
      }
      return status;
    },
    dump: (options?: DebugDumpOptions) => JSON.stringify(dumpDebugEvents(options), null, 2),
    dumpBubbleTimeline: (options?: DebugDumpOptions) => JSON.stringify(dumpBubbleTimeline(options), null, 2),
    clear: () => {
      clearDebugEvents();
    },
    status: () => getDebugStatus(),
  };
}

export function bootstrapDebugFromStorage() {
  const storages = getDebugStorages();
  if (!storages) return;

  const applyPayload = (raw: string, source: DebugStorageEntry): boolean => {
    const parsedBool = parseBooleanString(raw);
    if (parsedBool === false) {
      persistScope = source.kind;
      configureDebug({ enabled: false });
      return true;
    }

    if (parsedBool === true) {
      persistScope = source.kind;
      configureDebug({ enabled: true });
      ensureWindowDebugApi();
      return true;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isRecord(parsed)) return false;
    if (parsed.enabled !== true && parsed.enabled !== false) return false;

    const size = typeof parsed.size === 'number' ? parsed.size : undefined;
    const ttlMs = typeof parsed.ttlMs === 'number' ? parsed.ttlMs : undefined;
    const enabledValue = parsed.enabled === true;
    let effectiveTtlMs = ttlMs;

    if (enabledValue && typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)) {
      const remaining = parsed.expiresAt - Date.now();
      if (remaining <= 0) {
        clearStorageKey(source.storage, STORAGE_KEY);
        return false;
      }
      effectiveTtlMs = remaining;
    }

    persistScope = source.kind;
    configureDebug({
      enabled: enabledValue,
      size,
      ttlMs: effectiveTtlMs,
    });

    if (enabledValue) {
      ensureWindowDebugApi();
    }
    return true;
  };

  for (const source of storages) {
    const raw = safeReadStorage(source.storage, STORAGE_KEY);
    if (raw === null) continue;
    if (applyPayload(raw, source)) return;
  }
}

export const invocationDebugConstants = {
  DEFAULT_SIZE,
  MIN_SIZE,
  MAX_SIZE,
  DEFAULT_TTL_MS,
  STORAGE_KEY,
} as const;

export type {
  DebugConfigureInput,
  DebugDumpOptions,
  DebugDumpResult,
  DebugEventInput,
  DebugStatus,
  StoredDebugEvent,
} from './invocationEventDebug.types';
