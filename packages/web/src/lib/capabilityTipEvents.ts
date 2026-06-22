import { type CapabilityTipUsageEvent, CapabilityTipUsageEventSchema } from '@cat-cafe/shared';

const MAX_EVENTS = 100;
const EVENT_NAME = 'cat-cafe:capability-tip-event';

let records: CapabilityTipUsageEvent[] = [];

export function recordCapabilityTipEvent(input: CapabilityTipUsageEvent): boolean {
  const parsed = CapabilityTipUsageEventSchema.safeParse(input);
  if (!parsed.success) return false;

  records.push(parsed.data);
  if (records.length > MAX_EVENTS) {
    records = records.slice(records.length - MAX_EVENTS);
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
}

export const CAPABILITY_TIP_EVENT_NAME = EVENT_NAME;
