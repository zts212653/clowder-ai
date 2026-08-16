import type { TurnCustodyWakeProvenance } from './TurnCustodyProjectionService.js';

type AdoptionHandler = (wakes: readonly TurnCustodyWakeProvenance[]) => Promise<void>;

interface AdoptionEntry {
  readonly handler: AdoptionHandler;
  active: boolean;
  tail: Promise<void>;
}

/**
 * Process-local bridge from an invocation-authenticated tool read back to the
 * route generator that owns the same child. Queue custody remains durable; the
 * bridge only ensures the stop-gate baseline is opened before the tool returns
 * the newly exposed body to the provider.
 */
export class TurnCustodyAdoptionRegistry {
  private readonly handlers = new Map<string, AdoptionEntry>();

  register(invocationId: string, handler: AdoptionHandler): () => Promise<void> {
    if (!invocationId || this.handlers.has(invocationId)) {
      throw new Error(`turn custody adoption handler already registered for ${invocationId || '<empty>'}`);
    }
    const entry: AdoptionEntry = { handler, active: true, tail: Promise.resolve() };
    this.handlers.set(invocationId, entry);
    return async () => {
      if (!entry.active) return;
      entry.active = false;
      if (this.handlers.get(invocationId) === entry) this.handlers.delete(invocationId);
      await entry.tail;
    };
  }

  async adopt(invocationId: string, wakes: readonly TurnCustodyWakeProvenance[]): Promise<boolean> {
    if (wakes.length === 0) return true;
    const entry = this.handlers.get(invocationId);
    if (!entry) return false;
    let accepted = false;
    const adoption = entry.tail.then(async () => {
      if (!entry.active || this.handlers.get(invocationId) !== entry) return;
      accepted = true;
      await entry.handler(wakes);
    });
    entry.tail = adoption.catch(() => undefined);
    await adoption;
    return accepted;
  }

  resetForTest(): void {
    for (const entry of this.handlers.values()) entry.active = false;
    this.handlers.clear();
  }
}

export const turnCustodyAdoptionRegistry = new TurnCustodyAdoptionRegistry();
