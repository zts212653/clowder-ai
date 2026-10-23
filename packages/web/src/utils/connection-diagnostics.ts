import { type ConnectionDiagnosticEvent, connectionDiagnosticEventSchema } from '@cat-cafe/shared';
import { boundedFetch } from './bounded-fetch';

type Input<T> = T extends ConnectionDiagnosticEvent ? Omit<T, 'eventId' | 'at'> : never;
const STORAGE = 'cat-cafe:connection-diagnostics:v1';
const LIMIT = 240;
let pending: ConnectionDiagnosticEvent[] | undefined;
let delivery: { apiUrl: string; csrf: () => string | null } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;

export function connectionDiagnosticId(): string {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* Diagnostic identifiers are not security credentials. */
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (digit) =>
    (Number(digit) ^ ((Math.random() * 16) >> (Number(digit) / 4))).toString(16).slice(-1),
  );
}

function buffer(): ConnectionDiagnosticEvent[] {
  if (pending) return pending;
  pending = [];
  try {
    const serialized = localStorage.getItem(STORAGE) ?? '[]';
    const raw: unknown = serialized.length <= 262_144 ? JSON.parse(serialized) : [];
    if (Array.isArray(raw)) {
      for (const value of raw.slice(-LIMIT)) {
        const parsed = connectionDiagnosticEventSchema.safeParse(value);
        if (parsed.success) pending.push(parsed.data);
      }
    }
  } catch {
    /* Diagnostics remain usable in memory when storage is unavailable. */
  }
  return pending;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(buffer()));
  } catch {
    /* Never affect the observed operation. */
  }
}

export function scheduleConnectionDiagnosticDelivery(): void {
  if (!delivery || timer || inFlight || !buffer().length) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, 5_000);
}

/** The normal session owner supplies its current token; the diagnostic never establishes or refreshes a session. */
export function configureConnectionDiagnostics(apiUrl: string, csrf: () => string | null): void {
  delivery = { apiUrl, csrf };
  scheduleConnectionDiagnosticDelivery();
}

export function recordConnectionDiagnostic(input: Input<ConnectionDiagnosticEvent>): void {
  try {
    const parsed = connectionDiagnosticEventSchema.safeParse({
      ...input,
      eventId: connectionDiagnosticId(),
      at: Date.now(),
    });
    if (!parsed.success) return;
    buffer().push(parsed.data);
    if (buffer().length > LIMIT) pending = buffer().slice(-LIMIT);
    persist();
    scheduleConnectionDiagnosticDelivery();
  } catch {
    /* Observability must preserve return values, exceptions and navigation. */
  }
}

async function flush(): Promise<void> {
  const target = delivery;
  const csrf = target?.csrf();
  if (!target || !csrf || inFlight || !buffer().length) return;
  inFlight = true;
  const batch = buffer().slice(0, 60);
  let delivered = false;
  try {
    // Bypass apiFetch: a failed report must not create another report or toast.
    const response = await boundedFetch(
      `${target.apiUrl}/api/diagnostics/connection`,
      {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ v: 1, events: batch }),
      },
      2_000,
    );
    if (response.ok) {
      delivered = true;
      const deliveredIds = new Set(batch.map((event) => event.eventId));
      pending = buffer().filter((event) => !deliveredIds.has(event.eventId));
      persist();
    }
  } catch {
    /* Keep the bounded batch for a later normal request/session recovery. */
  } finally {
    inFlight = false;
  }
  if (delivered) scheduleConnectionDiagnosticDelivery();
  // No retry loop during an outage. New activity or session recovery schedules the next bounded attempt.
}
