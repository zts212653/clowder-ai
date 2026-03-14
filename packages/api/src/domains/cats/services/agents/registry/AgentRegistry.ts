/**
 * AgentRegistry — runtime mapping from catId → AgentService.
 *
 * Populated at startup alongside CatRegistry.
 * AgentRouter reads from this instead of hardcoded named parameters.
 */

import type { AgentService } from '../../types.js';

export class AgentRegistry {
  private services = new Map<string, AgentService>();

  /** Register an {@link AgentService} for a cat. Throws if already registered. */
  register(catId: string, service: AgentService): void {
    if (this.services.has(catId)) {
      throw new Error(`AgentService for "${catId}" is already registered`);
    }
    this.services.set(catId, service);
  }

  /** Retrieve the {@link AgentService} for a cat. Throws if not registered. */
  get(catId: string): AgentService {
    const service = this.services.get(catId);
    if (!service) {
      throw new Error(
        `No AgentService registered for "${catId}". Registered: ${Array.from(this.services.keys()).join(', ')}`,
      );
    }
    return service;
  }

  /** Check whether an {@link AgentService} is registered for a cat. */
  has(catId: string): boolean {
    return this.services.has(catId);
  }

  /** Return a shallow copy of all registered cat → service entries. */
  getAllEntries(): Map<string, AgentService> {
    return new Map(this.services);
  }

  /** Clear all entries. For testing only. */
  reset(): void {
    this.services.clear();
  }
}
