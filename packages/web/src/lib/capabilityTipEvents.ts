import { type CapabilityTipUsageEvent, CapabilityTipUsageEventSchema } from '@cat-cafe/shared';

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
    return parsed.filter((e: unknown) => CapabilityTipUsageEventSchema.safeParse(e).success);
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
