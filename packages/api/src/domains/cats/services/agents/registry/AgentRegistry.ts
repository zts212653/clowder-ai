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
  private refreshTail: Promise<void> = Promise.resolve();

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

  private clearGeneration(): Map<string, AgentService> {
    const previous = this.services;
    this.services = new Map();
    this.unavailable.clear();
    return previous;
  }

  private async disposeSuperseded(previous: Map<string, AgentService>): Promise<void> {
    const retained = new Set(this.services.values());
    const results = await Promise.allSettled(
      [...new Set(previous.values())]
        .filter((service) => !retained.has(service))
        .map(async (service) => {
          const owned = service as AgentService & { disposeHostService?(): Promise<void> };
          await owned.disposeHostService?.();
        }),
    );
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Superseded agent service disposal failed');
  }

  /** Clear immediately and retire owned preparations; running work retains its own lease. */
  reset(): Promise<void> {
    return this.disposeSuperseded(this.clearGeneration());
  }

  /** Build the new generation before releasing old service leases, preserving compatible warm pools. */
  refresh(rebuild: () => Promise<void>): Promise<void> {
    const run = async () => {
      const previous = this.clearGeneration();
      const results = await Promise.allSettled([Promise.resolve().then(rebuild)]);
      results.push(...(await Promise.allSettled([this.disposeSuperseded(previous)])));
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Agent registry refresh failed');
    };
    const result = this.refreshTail.then(run, run);
    this.refreshTail = result;
    return result;
  }
}
