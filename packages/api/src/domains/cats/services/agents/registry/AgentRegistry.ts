/**
 * AgentRegistry — runtime mapping from catId → AgentService.
 *
 * Populated at startup alongside CatRegistry.
 * AgentRouter reads from this instead of hardcoded named parameters.
 */

import type { AgentService } from '../../types.js';
import { type AgentRegistrationFailure, AgentServiceUnavailableError } from './AgentServiceUnavailableError.js';

export class AgentRegistry {
  private services = new Map<string, AgentService>();
  private unavailable = new Map<string, AgentRegistrationFailure>();

  /** Register an {@link AgentService} for a cat. Throws if already registered. */
  register(catId: string, service: AgentService): void {
    if (this.services.has(catId)) {
      throw new Error(`AgentService for "${catId}" is already registered`);
    }
    this.services.set(catId, service);
    this.unavailable.delete(catId);
  }

  /** Preserve a skipped member's cause without making it eligible for dispatch. */
  markUnavailable(catId: string, reason: AgentRegistrationFailure): void {
    this.services.delete(catId);
    this.unavailable.set(catId, Object.freeze({ ...reason }));
  }

  /** Retrieve the {@link AgentService} for a cat. Throws if not registered. */
  get(catId: string): AgentService {
    const service = this.services.get(catId);
    if (!service) {
      const reason = this.unavailable.get(catId);
      if (reason) throw new AgentServiceUnavailableError(catId, reason);
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

  /** Snapshot diagnostics separately from the ready-service set. */
  getAllUnavailableEntries(): ReadonlyMap<string, AgentRegistrationFailure> {
    return new Map(this.unavailable);
  }

  /** Clear the previous registration generation before a catalog/account refresh. */
  reset(): void {
    this.services.clear();
    this.unavailable.clear();
  }
}
