import {
  type CollectiveEventEnvelope,
  type CollectivePairingIntent,
  collectiveAckRequestSchema,
  collectiveAgentMessageRequestSchema,
  collectiveConnectionCoordinatesSchema,
  collectiveHumanMessageRequestSchema,
  collectivePollRequestSchema,
} from '@cat-cafe/shared';

import {
  assertConnectionCoordinates,
  assertServiceCoordinates,
  projectConnection,
  readPollBatch,
  requireAuthorizedHuman,
  requireConnection,
} from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import { requireHumanAuthBinding, requireMembership, requireSteward, resolveSession } from './identity-store.js';
import {
  createSecret,
  createStableId,
  digestSecret,
  type PersistentServiceState,
  secretMatches,
} from './persistence.js';
import type { ConnectionRecord } from './state.js';

export interface PairingExchangeInput {
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly pairingIntentId: string;
  readonly hostOrigin: string;
  readonly nonce: string;
  readonly endpointLabel: string;
}

export class CollectiveConnectionEventStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}

  async createPairingIntent(input: {
    sessionToken: string;
    collectiveId: string;
    hostOrigin: string;
    nonce: string;
    ttlMs?: number;
  }): Promise<CollectivePairingIntent> {
    const hostOrigin = new URL(input.hostOrigin).origin;
    if (input.nonce.length < 16 || input.nonce.length > 200) {
      throw new CollectiveServiceError('PAIRING_INVALID', 'Pairing nonce is invalid', 400);
    }
    return this.persistence.transaction((state) => {
      const auth = resolveSession(state, input.sessionToken);
      requireHumanAuthBinding(state, auth.human.humanId);
      requireMembership(state, input.collectiveId, auth.human.humanId);
      const now = this.now();
      const pairingIntentId = createStableId('pair_');
      const expiresAt = new Date(now + (input.ttlMs ?? 5 * 60 * 1_000)).toISOString();
      state.pairingIntents[pairingIntentId] = {
        pairingIntentId,
        collectiveId: input.collectiveId,
        createdByHumanId: auth.human.humanId,
        hostOrigin,
        nonceDigest: digestSecret(input.nonce),
        createdAt: new Date(now).toISOString(),
        expiresAt,
      };
      return {
        serviceInstanceId: state.serviceInstanceId,
        collectiveId: input.collectiveId,
        pairingIntentId,
        hostOrigin,
        nonce: input.nonce,
        expiresAt,
      };
    });
  }

  async exchangePairingIntent(input: PairingExchangeInput) {
    const endpointLabel = input.endpointLabel.trim();
    if (!endpointLabel || endpointLabel.length > 160) {
      throw new CollectiveServiceError('PAIRING_INVALID', 'Endpoint label is required', 400);
    }
    return this.persistence.transaction((state) => {
      assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
      const pairing = state.pairingIntents[input.pairingIntentId];
      if (!pairing || pairing.collectiveId !== input.collectiveId) {
        throw new CollectiveServiceError('PAIRING_INVALID', 'Pairing intent is invalid', 401);
      }
      if (pairing.consumedAt) {
        throw new CollectiveServiceError('PAIRING_ALREADY_CONSUMED', 'Pairing intent was already consumed', 409);
      }
      const now = this.now();
      if (Date.parse(pairing.expiresAt) < now) {
        throw new CollectiveServiceError('PAIRING_EXPIRED', 'Pairing intent expired', 410);
      }
      if (pairing.hostOrigin !== new URL(input.hostOrigin).origin || !secretMatches(input.nonce, pairing.nonceDigest)) {
        throw new CollectiveServiceError('PAIRING_INVALID', 'Pairing intent is invalid', 401);
      }
      requireMembership(state, input.collectiveId, pairing.createdByHumanId);
      pairing.consumedAt = new Date(now).toISOString();
      const endpointCredential = createSecret();
      const connection: ConnectionRecord = {
        connectionId: createStableId('con_'),
        collectiveId: input.collectiveId,
        endpointId: createStableId('ep_'),
        endpointLabel,
        credentialDigest: digestSecret(endpointCredential),
        authorizedHumanId: pairing.createdByHumanId,
        status: 'connected',
        lastDeliveredSequence: 0,
        lastAckedSequence: 0,
        createdAt: new Date(now).toISOString(),
      };
      state.connections[connection.connectionId] = connection;
      return {
        serviceInstanceId: state.serviceInstanceId,
        collectiveId: input.collectiveId,
        connectionId: connection.connectionId,
        endpointId: connection.endpointId,
        authorizedHumanId: pairing.createdByHumanId,
        endpointCredential,
      };
    });
  }

  async postHumanMessage(sessionToken: string, unsafeInput: unknown): Promise<CollectiveEventEnvelope> {
    const input = collectiveHumanMessageRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
      const auth = resolveSession(state, sessionToken);
      requireHumanAuthBinding(state, auth.human.humanId);
      requireMembership(state, input.collectiveId, auth.human.humanId);
      return appendEvent(state, {
        coordinates: input,
        actorScope: `human:${auth.human.humanId}`,
        actor: {
          kind: 'human',
          humanId: auth.human.humanId,
          displayName: auth.human.displayName,
        },
        now: this.now(),
      });
    });
  }

  async postAgentMessage(endpointCredential: string, unsafeInput: unknown): Promise<CollectiveEventEnvelope> {
    const input = collectiveAgentMessageRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, endpointCredential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      const authorizedHuman = requireAuthorizedHuman(state, connection);
      return appendEvent(state, {
        coordinates: input,
        actorScope: `connection:${connection.connectionId}`,
        actor: {
          kind: 'agent',
          human: {
            humanId: authorizedHuman.humanId,
            displayName: authorizedHuman.displayName,
          },
          agent: {
            agentId: input.agent.agentId,
            displayName: input.agent.displayName,
          },
          provenance: {
            connectionId: connection.connectionId,
            endpointId: connection.endpointId,
            endpointLabel: connection.endpointLabel,
            catId: input.agent.catId,
            sessionRef: input.agent.sessionRef,
          },
        },
        now: this.now(),
      });
    });
  }

  async listEventsForHuman(sessionToken: string, collectiveId: string): Promise<CollectiveEventEnvelope[]> {
    const state = this.persistence.snapshot();
    const auth = resolveSession(state, sessionToken);
    requireHumanAuthBinding(state, auth.human.humanId);
    requireMembership(state, collectiveId, auth.human.humanId);
    return structuredClone(state.events[collectiveId] ?? []);
  }

  async pollEvents(endpointCredential: string, unsafeInput: unknown) {
    const input = collectivePollRequestSchema.parse(unsafeInput);
    const initial = readPollBatch(this.persistence.snapshot(), endpointCredential, input);
    if (initial.events.length === 0) {
      return {
        serviceInstanceId: initial.state.serviceInstanceId,
        collectiveId: input.collectiveId,
        connectionId: initial.connection.connectionId,
        lastAckedSequence: initial.connection.lastAckedSequence,
        events: [],
      };
    }
    return this.persistence.transaction((state) => {
      const { connection, events } = readPollBatch(state, endpointCredential, input);
      const deliveredSequence = events.at(-1)?.sequence ?? connection.lastDeliveredSequence;
      const mutableConnection = state.connections[connection.connectionId];
      if (!mutableConnection) {
        throw new CollectiveServiceError('CONNECTION_NOT_FOUND', 'Connection was not found', 404);
      }
      mutableConnection.lastDeliveredSequence = Math.max(connection.lastDeliveredSequence, deliveredSequence);
      return {
        serviceInstanceId: state.serviceInstanceId,
        collectiveId: input.collectiveId,
        connectionId: connection.connectionId,
        lastAckedSequence: connection.lastAckedSequence,
        events: structuredClone(events),
      };
    });
  }

  async acknowledge(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveAckRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, endpointCredential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      requireAuthorizedHuman(state, connection);
      if (input.sequence < connection.lastAckedSequence || input.sequence > connection.lastDeliveredSequence) {
        throw new CollectiveServiceError('ACK_OUT_OF_RANGE', 'ACK is outside delivered order', 409);
      }
      state.connections[connection.connectionId] = {
        ...connection,
        lastAckedSequence: input.sequence,
      };
      return { ...input, lastAckedSequence: input.sequence };
    });
  }

  async revokeConnection(input: { sessionToken: string; collectiveId: string; connectionId: string }) {
    return this.persistence.transaction((state) => {
      const auth = resolveSession(state, input.sessionToken);
      requireHumanAuthBinding(state, auth.human.humanId);
      requireSteward(state, input.collectiveId, auth.human.humanId);
      const connection = state.connections[input.connectionId];
      if (!connection || connection.collectiveId !== input.collectiveId) {
        throw new CollectiveServiceError('CONNECTION_NOT_FOUND', 'Connection was not found', 404);
      }
      connection.status = 'revoked';
      connection.revokedAt ??= new Date(this.now()).toISOString();
      connection.revocationReason = 'owner_revoked';
      return projectConnection(connection, state.serviceInstanceId);
    });
  }

  async revokeOwnConnection(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveConnectionCoordinatesSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, endpointCredential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      const revoked: ConnectionRecord = {
        ...connection,
        status: 'revoked',
        revokedAt: new Date(this.now()).toISOString(),
        revocationReason: 'self_revoked',
      };
      state.connections[connection.connectionId] = revoked;
      return projectConnection(revoked, state.serviceInstanceId);
    });
  }

  async getConnectionProjection(connectionId: string) {
    const state = this.persistence.snapshot();
    const connection = state.connections[connectionId];
    if (!connection) {
      throw new CollectiveServiceError('CONNECTION_NOT_FOUND', 'Connection was not found', 404);
    }
    return projectConnection(connection, state.serviceInstanceId);
  }
}
