import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLECTIVE_CLIENT_BUILD_ID } from '@cat-cafe/collective-client';
import { CollectiveConnectionEventStore, type PairingExchangeInput } from './connection-event-store.js';
import { CollectiveServiceError } from './errors.js';
import type { HumanAuthProvider, HumanAuthProviderId } from './human-auth-provider.js';
import { CollectiveIdentityStore } from './identity-store.js';
import {
  createSecret,
  createStableId,
  digestSecret,
  PersistentServiceState,
  SERVICE_STATE_FILE,
} from './persistence.js';
import type { ServiceState } from './state.js';

export interface OpenCollectiveServiceStoreOptions {
  readonly dataDirectory: string;
  readonly now?: () => number;
  readonly bootstrapTtlMs?: number;
  readonly humanAuthProvider?: HumanAuthProvider;
  readonly humanAuthRedirectUri?: string;
}

export interface OpenedCollectiveServiceStore {
  readonly store: CollectiveServiceStore;
  readonly bootstrapSecret?: string;
}

export class CollectiveServiceStore {
  readonly #identity: CollectiveIdentityStore;
  readonly #connections: CollectiveConnectionEventStore;

  private constructor(
    private readonly persistence: PersistentServiceState,
    now: () => number,
    humanAuthProvider?: HumanAuthProvider,
    humanAuthRedirectUri?: string,
  ) {
    this.#identity = new CollectiveIdentityStore(persistence, now, humanAuthProvider, humanAuthRedirectUri);
    this.#connections = new CollectiveConnectionEventStore(persistence, now);
  }

  static async open(options: OpenCollectiveServiceStoreOptions): Promise<OpenedCollectiveServiceStore> {
    const now = options.now ?? Date.now;
    const stateFile = join(options.dataDirectory, SERVICE_STATE_FILE);
    try {
      await access(stateFile);
      const persistence = await PersistentServiceState.load(options.dataDirectory);
      return {
        store: new CollectiveServiceStore(persistence, now, options.humanAuthProvider, options.humanAuthRedirectUri),
      };
    } catch (error) {
      if (error instanceof CollectiveServiceError) throw error;
      if (!isMissingFile(error)) {
        throw new CollectiveServiceError(
          'STATE_CORRUPT',
          `Collective Service state could not be loaded: ${errorMessage(error)}`,
          500,
        );
      }
      const bootstrapSecret = createSecret();
      const createdAt = new Date(now()).toISOString();
      const state: ServiceState = {
        schemaVersion: 2,
        serviceInstanceId: createStableId('svc_'),
        createdAt,
        bootstrap: {
          tokenDigest: digestSecret(bootstrapSecret),
          expiresAt: new Date(now() + (options.bootstrapTtlMs ?? 24 * 60 * 60 * 1_000)).toISOString(),
        },
        humans: {},
        sessions: {},
        humanAuthBindings: {},
        humanAuthAttempts: {},
        humanAuthCompletions: {},
        collectives: {},
        memberships: {},
        invites: {},
        pairingIntents: {},
        connections: {},
        events: {},
        legacyEvents: {},
        clientEventIndex: {},
      };
      const persistence = await PersistentServiceState.create(options.dataDirectory, state);
      return {
        store: new CollectiveServiceStore(persistence, now, options.humanAuthProvider, options.humanAuthRedirectUri),
        bootstrapSecret,
      };
    }
  }

  get serviceInstanceId(): string {
    return this.persistence.snapshot().serviceInstanceId;
  }

  getMetadata() {
    const state = this.persistence.snapshot();
    return {
      serviceInstanceId: state.serviceInstanceId,
      createdAt: state.createdAt,
      bootstrapNeeded: state.bootstrap.consumedAt === undefined,
      clientBuildId: COLLECTIVE_CLIENT_BUILD_ID,
    };
  }

  consumeBootstrap(input: { secret: string; displayName: string }) {
    return this.#identity.consumeBootstrap(input);
  }

  requireSession(sessionToken: string) {
    return this.#identity.requireSession(sessionToken);
  }

  createCollective(input: { sessionToken: string; name: string }) {
    return this.#identity.createCollective(input);
  }

  listCollectives(sessionToken: string) {
    return this.#identity.listCollectives(sessionToken);
  }

  getHumanProjection(sessionToken: string) {
    return this.#identity.getHumanProjection(sessionToken);
  }

  createInvite(input: { sessionToken: string; collectiveId: string; ttlMs?: number }) {
    return this.#identity.createInvite(input);
  }

  getHumanAuthProviders() {
    return this.#identity.getHumanAuthProviders();
  }

  getHumanAuthRedirectUri() {
    return this.#identity.getHumanAuthRedirectUri();
  }

  beginHumanAuth(input: Parameters<CollectiveIdentityStore['beginHumanAuth']>[0]) {
    return this.#identity.beginHumanAuth(input);
  }

  completeHumanAuth(input: { provider: HumanAuthProviderId; state: string; code: string; ttlMs?: number }) {
    return this.#identity.completeHumanAuth(input);
  }

  exchangeHumanAuthCompletion(completionToken: string) {
    return this.#identity.exchangeHumanAuthCompletion(completionToken);
  }

  joinInvite(input: { inviteToken: string; displayName: string }) {
    return this.#identity.joinInvite(input);
  }

  createPairingIntent(input: {
    sessionToken: string;
    collectiveId: string;
    hostOrigin: string;
    nonce: string;
    ttlMs?: number;
  }) {
    return this.#connections.createPairingIntent(input);
  }

  exchangePairingIntent(input: PairingExchangeInput) {
    return this.#connections.exchangePairingIntent(input);
  }

  postHumanMessage(sessionToken: string, input: unknown) {
    return this.#connections.postHumanMessage(sessionToken, input);
  }

  postAgentMessage(endpointCredential: string, input: unknown) {
    return this.#connections.postAgentMessage(endpointCredential, input);
  }

  listEventsForHuman(sessionToken: string, collectiveId: string) {
    return this.#connections.listEventsForHuman(sessionToken, collectiveId);
  }

  pollEvents(endpointCredential: string, input: unknown) {
    return this.#connections.pollEvents(endpointCredential, input);
  }

  acknowledge(endpointCredential: string, input: unknown) {
    return this.#connections.acknowledge(endpointCredential, input);
  }

  revokeConnection(input: { sessionToken: string; collectiveId: string; connectionId: string }) {
    return this.#connections.revokeConnection(input);
  }

  revokeOwnConnection(endpointCredential: string, input: unknown) {
    return this.#connections.revokeOwnConnection(endpointCredential, input);
  }

  getConnectionProjection(connectionId: string) {
    return this.#connections.getConnectionProjection(connectionId);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { CollectiveServiceError } from './errors.js';
