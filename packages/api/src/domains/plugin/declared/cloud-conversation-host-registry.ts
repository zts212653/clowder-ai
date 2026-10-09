import type { CloudConversationHostContribution } from '@clowder-ai/plugin-contract';
import { createModuleLogger } from '../../../infrastructure/logger.js';
import type { PluginInvocationOutcome } from '../carrier/host-invocation.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

const log = createModuleLogger('plugin/cloud-conversation-hosts');

export type CloudConversationProvider = CloudConversationHostContribution['provider'];

export interface CloudConversationHostRegistration {
  readonly provider: CloudConversationProvider;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly contribution: CloudConversationHostContribution;
  /** Calls one of the package's actions; a failure says whether the package could have acted on it. */
  attempt(method: string, params: unknown): Promise<PluginInvocationOutcome>;
}

/**
 * One activation's hold on its provider. A lease is never reused: a package that is stopped and
 * started again (same instance or not) gets a new one, with a higher generation.
 */
export interface CloudConversationHostLease extends CloudConversationHostRegistration {
  readonly generation: number;
}

/** The change a listener was told about when it failed. */
export interface CloudConversationHostChange {
  readonly kind: 'registered' | 'unregistered';
  readonly provider: CloudConversationProvider;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly generation: number;
}

export interface CloudConversationHostRegistryOptions {
  /** Where a failing listener is reported. Defaults to the plugin module log. */
  readonly onListenerError?: (error: unknown, change: CloudConversationHostChange) => void;
}

/**
 * F202 W2-3 h3b — which enabled package hosts each cloud conversation provider (contract
 * `cloud-conversation-host`; one provider accepts at most one enabled package).
 *
 * The declared runtime contributions register a package as the last step of its activation and
 * unregister it before its carrier stops, so the registry holds exactly the packages that are
 * enabled and running. The Host's outbound adapter and reply poller read it; they never keep a
 * package of their own.
 *
 * `register` fails only before it changes anything (a provider already held), and `unregister`
 * never fails. Listeners are told after the change is made, so a listener that throws is reported
 * and skipped: its failure never reaches the activation or teardown that made the change (which
 * would otherwise lose the lease it just registered, or stop halfway through releasing the rest),
 * and never keeps the listeners after it from being told.
 */
export class CloudConversationHostRegistry {
  readonly #current = new Map<CloudConversationProvider, CloudConversationHostLease>();
  readonly #listeners = new Set<() => void>();
  readonly #onListenerError: (error: unknown, change: CloudConversationHostChange) => void;
  #generation = 0;

  constructor(options: CloudConversationHostRegistryOptions = {}) {
    this.#onListenerError =
      options.onListenerError ??
      ((error, change) => log.error({ err: error, ...change }, 'cloud conversation host registry listener failed'));
  }

  /** Refuses a second package for a provider that already has one: the activation fails closed. */
  register(registration: CloudConversationHostRegistration): CloudConversationHostLease {
    const holder = this.#current.get(registration.provider);
    if (holder) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${registration.pluginId} cannot host ${registration.provider} conversations: ${holder.pluginId} already does`,
      );
    }
    const lease: CloudConversationHostLease = Object.freeze({ ...registration, generation: this.#generation + 1 });
    this.#generation = lease.generation;
    this.#current.set(registration.provider, lease);
    this.#notify('registered', lease);
    return lease;
  }

  /** Removes the provider's holder only if it is still this very lease. */
  unregister(lease: CloudConversationHostLease): void {
    if (!this.isCurrent(lease)) return;
    this.#current.delete(lease.provider);
    this.#notify('unregistered', lease);
  }

  current(provider: CloudConversationProvider): CloudConversationHostLease | undefined {
    return this.#current.get(provider);
  }

  isCurrent(lease: CloudConversationHostLease): boolean {
    return this.#current.get(lease.provider) === lease;
  }

  /** Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(kind: CloudConversationHostChange['kind'], lease: CloudConversationHostLease): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#report(error, {
          kind,
          provider: lease.provider,
          pluginId: lease.pluginId,
          pluginInstanceId: lease.pluginInstanceId,
          generation: lease.generation,
        });
      }
    }
  }

  #report(error: unknown, change: CloudConversationHostChange): void {
    try {
      this.#onListenerError(error, change);
    } catch {
      // The report itself failed. There is nowhere left to send it, and the change must stand.
    }
  }
}
