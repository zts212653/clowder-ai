import type { CapabilityTipUsageEvent, TipEventBatch } from '@cat-cafe/shared';
import type { TipEventSender } from '../capabilityTipQueue';

export const store = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
  clear: () => store.clear(),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

export function makeEvent(tipId = 'test-tip', ts = Date.now()): CapabilityTipUsageEvent {
  return {
    event: 'capability_tip_exposed',
    tipId,
    context: 'thinking',
    surface: 'pending_bubble',
    outcome: 'shown',
    timestamp: ts,
  };
}

export function makeSuccessSender(): TipEventSender & { calls: TipEventBatch[] } {
  const calls: TipEventBatch[] = [];
  const sender = async (batch: TipEventBatch) => {
    calls.push(batch);
    return { accepted: batch.events.length, rejected: 0 };
  };
  sender.calls = calls;
  return sender as TipEventSender & { calls: TipEventBatch[] };
}

export function makeFailingSender(failCount = Infinity): TipEventSender & { calls: TipEventBatch[] } {
  const calls: TipEventBatch[] = [];
  let failsRemaining = failCount;
  const sender = async (batch: TipEventBatch) => {
    calls.push(batch);
    if (failsRemaining > 0) {
      failsRemaining--;
      throw new Error('Network error');
    }
    return { accepted: batch.events.length, rejected: 0 };
  };
  return Object.assign(sender, { calls });
}
