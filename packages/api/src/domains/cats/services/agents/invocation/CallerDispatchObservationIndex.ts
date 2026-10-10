import type {
  CallerDispatchObservationInclusion,
  CallerDispatchObservationPointer,
} from './caller-dispatch-observation-model.js';

export interface CallerDispatchObservationEntry extends CallerDispatchObservationPointer {
  presentedFingerprint?: string;
  observedFingerprint?: string;
  actualFingerprint?: string;
  touchedAt: number;
}

const MAX_ENTRIES_PER_SLOT = 128;
const MAX_OBSERVATION_SLOTS = 512;
const OBSERVATION_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Process-local bounded index; canonical dispatch truth remains in History. */
export class CallerDispatchObservationIndex {
  private readonly bySlot = new Map<string, Map<string, CallerDispatchObservationEntry>>();

  private prune(now = Date.now()): void {
    const cutoff = now - OBSERVATION_IDLE_TTL_MS;
    for (const [slotKey, entries] of this.bySlot) {
      for (const [key, entry] of entries) {
        if (entry.touchedAt < cutoff) entries.delete(key);
      }
      if (entries.size === 0) this.bySlot.delete(slotKey);
    }
  }

  private ensureSlot(slotKey: string, now: number): Map<string, CallerDispatchObservationEntry> {
    const existing = this.bySlot.get(slotKey);
    if (existing) return existing;
    this.prune(now);
    if (this.bySlot.size >= MAX_OBSERVATION_SLOTS) {
      const oldest = [...this.bySlot].sort(
        ([, left], [, right]) =>
          Math.min(...[...left.values()].map((entry) => entry.touchedAt)) -
          Math.min(...[...right.values()].map((entry) => entry.touchedAt)),
      )[0];
      if (oldest) this.bySlot.delete(oldest[0]);
    }
    const entries = new Map<string, CallerDispatchObservationEntry>();
    this.bySlot.set(slotKey, entries);
    return entries;
  }

  get(slotKey: string, key: string): CallerDispatchObservationEntry | undefined {
    return this.bySlot.get(slotKey)?.get(key);
  }

  set(slotKey: string, key: string, entry: CallerDispatchObservationEntry): void {
    const entries = this.ensureSlot(slotKey, entry.touchedAt);
    entries.set(key, entry);
    if (entries.size <= MAX_ENTRIES_PER_SLOT) return;
    const oldest = [...entries].sort(([, left], [, right]) => left.touchedAt - right.touchedAt)[0];
    if (oldest) entries.delete(oldest[0]);
  }

  list(slotKey: string): readonly CallerDispatchObservationPointer[] {
    this.prune();
    return [...(this.bySlot.get(slotKey)?.values() ?? [])];
  }

  acknowledge(included: readonly CallerDispatchObservationInclusion[]): void {
    for (const observation of included) {
      for (const [slotKey, entries] of this.bySlot) {
        const current = entries.get(observation.key);
        if (!current || current.revision !== observation.includedRevision) continue;
        if (observation.terminal) {
          entries.delete(observation.key);
          if (entries.size === 0) this.bySlot.delete(slotKey);
          break;
        }
        entries.set(observation.key, {
          ...current,
          presentedRevision: observation.includedRevision,
          presentedFingerprint: observation.fingerprint,
          touchedAt: Date.now(),
        });
        break;
      }
    }
  }
}
