import { type CapabilityTipUsageEvent, CapabilityTipUsageEventSchema, TIP_MAX_AGE_MS } from '@cat-cafe/shared';
import { getTipEventQueue } from './capabilityTipQueue';
// Side-effect import: wires the sender to the queue singleton (auto-init)
import './capabilityTipSender';

const MAX_EVENTS = 100;
const EVENT_NAME = 'cat-cafe:capability-tip-event';
const STORAGE_KEY = 'cat-cafe:tip-events';

// ── localStorage persistence (Phase D) ──────────────────────────────────────

function loadFromStorage(): CapabilityTipUsageEvent[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each entry to guard against corrupted data
    const valid = parsed.filter((e: unknown) => CapabilityTipUsageEventSchema.safeParse(e).success);
    // Sol R2 P1-1: prune events older than 7d max-age AND persist clean array back
    const cutoff = Date.now() - TIP_MAX_AGE_MS;
    const fresh = valid.filter((e: CapabilityTipUsageEvent) => e.timestamp >= cutoff);
    // Persist pruned result so stale entries don't permanently occupy localStorage
    if (fresh.length < parsed.length) {
      saveToStorage(fresh);
    }
    return fresh;
  } catch {
    return [];
  }
}

function saveToStorage(events: CapabilityTipUsageEvent[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // localStorage full or blocked — degrade silently
  }
}

let records: CapabilityTipUsageEvent[] = loadFromStorage();

export function recordCapabilityTipEvent(input: CapabilityTipUsageEvent): boolean {
  const parsed = CapabilityTipUsageEventSchema.safeParse(input);
  if (!parsed.success) return false;

  records.push(parsed.data);
  if (records.length > MAX_EVENTS) {
    records = records.slice(records.length - MAX_EVENTS);
  }

  saveToStorage(records);

  // F268: Enqueue into batch upload queue (non-blocking, fire-and-forget)
  try {
    getTipEventQueue().enqueue(parsed.data);
  } catch {
    // Queue failure must never block tip display (AC-A2)
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: parsed.data }));
  }

  return true;
}

export function getCapabilityTipEvents(): CapabilityTipUsageEvent[] {
  return records.map((event) => ({ ...event }));
}

export function clearCapabilityTipEvents() {
  records = [];
  saveToStorage(records);
}

export const CAPABILITY_TIP_EVENT_NAME = EVENT_NAME;
