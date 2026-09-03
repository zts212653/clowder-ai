import { CollectiveServiceError } from './errors.js';
import { requireMembership } from './identity-store.js';
import { secretMatches } from './persistence.js';
import type { ConnectionRecord, ServiceState } from './state.js';

export function readPollBatch<State extends ServiceState>(
  state: State,
  endpointCredential: string,
  input: {
    serviceInstanceId: string;
    collectiveId: string;
    connectionId: string;
    afterSequence: number;
    limit: number;
  },
) {
  const connection = requireConnection(state, endpointCredential, input.connectionId);
  assertConnectionCoordinates(state, connection, input);
  requireAuthorizedHuman(state, connection);
  if (input.afterSequence !== connection.lastAckedSequence) {
    throw new CollectiveServiceError('POLL_CURSOR_MISMATCH', 'Poll cursor must start from the canonical ACK', 409);
  }
  return {
    state,
    connection,
    events: (state.events[input.collectiveId] ?? [])
      .filter((event) => event.sequence > input.afterSequence)
      .slice(0, input.limit),
  };
}

export function requireConnection(
  state: Pick<ServiceState, 'connections'>,
  endpointCredential: string,
  connectionId: string,
): ConnectionRecord {
  const connection = state.connections[connectionId];
  if (!connection || !secretMatches(endpointCredential, connection.credentialDigest)) {
    throw new CollectiveServiceError('CONNECTION_NOT_FOUND', 'Connection credential is invalid', 401);
  }
  if (connection.status === 'revoked') {
    throw new CollectiveServiceError('CONNECTION_REVOKED', 'Connection was revoked', 401);
  }
  return connection;
}

export function assertServiceCoordinates(state: ServiceState, serviceInstanceId: string, collectiveId: string): void {
  if (state.serviceInstanceId !== serviceInstanceId || !state.collectives[collectiveId]) {
    throw new CollectiveServiceError('COORDINATE_MISMATCH', 'Collective coordinates do not match', 409);
  }
}

export function assertConnectionCoordinates(
  state: ServiceState,
  connection: ConnectionRecord,
  input: { serviceInstanceId: string; collectiveId: string; connectionId: string },
): void {
  assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
  if (connection.connectionId !== input.connectionId || connection.collectiveId !== input.collectiveId) {
    throw new CollectiveServiceError('COORDINATE_MISMATCH', 'Connection coordinates do not match', 409);
  }
}

export function projectConnection(connection: ConnectionRecord, serviceInstanceId: string) {
  return {
    serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
    endpointId: connection.endpointId,
    endpointLabel: connection.endpointLabel,
    authorizedHumanId: connection.authorizedHumanId,
    status: connection.status,
    revocationReason: connection.revocationReason,
    lastAckedSequence: connection.lastAckedSequence,
    createdAt: connection.createdAt,
    revokedAt: connection.revokedAt,
  };
}

export function requireAuthorizedHuman(state: ServiceState, connection: ConnectionRecord) {
  const human = connection.authorizedHumanId ? state.humans[connection.authorizedHumanId] : undefined;
  if (!human) {
    throw new CollectiveServiceError('CONNECTION_REVOKED', 'Connection Human authority is unavailable', 401);
  }
  requireMembership(state, connection.collectiveId, human.humanId);
  return human;
}
