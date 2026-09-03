import { ConnectorPersistence } from './persistence.js';
import { type ConnectorProjection, projectConnection } from './projection.js';
import { CollectiveServiceClient, ConnectorTransportError } from './service-client.js';
import type { ConnectorConnectionState } from './state.js';

export interface ConnectorSyncHooks {
  readonly afterInboxPersist?: () => void | Promise<void>;
}

export class ConnectorSynchronization {
  readonly #syncs = new Map<string, Promise<ConnectorProjection>>();

  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
    private readonly now: () => number,
  ) {}

  sync(connectionId: string, hooks: ConnectorSyncHooks = {}): Promise<ConnectorProjection> {
    const existing = this.#syncs.get(connectionId);
    if (existing) return existing;
    const running = this.performSync(connectionId, hooks).finally(() => {
      if (this.#syncs.get(connectionId) === running) this.#syncs.delete(connectionId);
    });
    this.#syncs.set(connectionId, running);
    return running;
  }

  async revoke(connectionId: string): Promise<ConnectorProjection> {
    await this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      if (connection.authorityStatus === 'revoked') return;
      connection.authorityStatus = 'revoking';
    });
    return this.finishRevoke(connectionId);
  }

  private async performSync(connectionId: string, hooks: ConnectorSyncHooks): Promise<ConnectorProjection> {
    const initialSnapshot = this.persistence.snapshot();
    const initial = requireConnection(initialSnapshot.connections[connectionId]);
    if (initial.authorityStatus === 'revoked') {
      return projectConnection(initial, initialSnapshot.hostRoutes[connectionId]);
    }
    if (initial.authorityStatus === 'revoking') return this.finishRevoke(connectionId);
    if (initial.pendingAckSequence !== undefined) {
      try {
        await this.finishPendingAck(connectionId);
      } catch (error) {
        if (!(error instanceof ConnectorTransportError)) throw error;
        return this.markOffline(connectionId, error.message, error.causeCode);
      }
    }
    const hadPendingOutbox = initial.outbox.some((item) => item.status !== 'accepted');
    const flushed = await this.flushOutbox(connectionId);
    // Polling is the reconnect probe when no outbound item was attempted.
    if (hadPendingOutbox && flushed.liveStatus === 'offline') return flushed;
    const current = requireConnection(this.persistence.snapshot().connections[connectionId]);
    try {
      const delivery = await this.service.poll(current.serviceUrl, requireCredential(current), {
        serviceInstanceId: current.serviceInstanceId,
        collectiveId: current.collectiveId,
        connectionId: current.connectionId,
        afterSequence: current.lastAckedSequence,
        limit: 100,
      });
      await this.persistence.transaction((state) => {
        const connection = requireConnection(state.connections[connectionId]);
        const known = new Set(connection.inbox.map((item) => item.event.eventId));
        for (const event of delivery.events) {
          if (known.has(event.eventId)) continue;
          connection.inbox.push({
            event,
            disposition: 'persisted',
            persistedAt: new Date(this.now()).toISOString(),
          });
          known.add(event.eventId);
        }
        connection.liveStatus = 'online';
        delete connection.lastError;
        delete connection.lastErrorCode;
      });
      await hooks.afterInboxPersist?.();
      return await this.acknowledgeContiguous(connectionId);
    } catch (error) {
      if (!(error instanceof ConnectorTransportError)) throw error;
      return this.markOffline(connectionId, error.message, error.causeCode);
    }
  }

  private async flushOutbox(connectionId: string): Promise<ConnectorProjection> {
    while (true) {
      const snapshot = requireConnection(this.persistence.snapshot().connections[connectionId]);
      const pending = snapshot.outbox.find((item) => item.status !== 'accepted');
      if (!pending) return projectConnection(snapshot, this.persistence.snapshot().hostRoutes[connectionId]);
      await this.persistence.transaction((state) => {
        const item = requireConnection(state.connections[connectionId]).outbox.find(
          (candidate) => candidate.outboxId === pending.outboxId,
        );
        if (item) item.status = 'sending';
      });
      try {
        const event = await this.service.postAgentMessage(snapshot.serviceUrl, requireCredential(snapshot), {
          serviceInstanceId: snapshot.serviceInstanceId,
          collectiveId: snapshot.collectiveId,
          connectionId: snapshot.connectionId,
          clientEventId: pending.clientEventId,
          agent: pending.agent,
          target: pending.target,
          ...(pending.replyToEventId ? { replyToEventId: pending.replyToEventId } : {}),
          body: pending.body,
        });
        await this.persistence.transaction((state) => {
          const connection = requireConnection(state.connections[connectionId]);
          const item = connection.outbox.find((candidate) => candidate.outboxId === pending.outboxId);
          if (item) {
            item.status = 'accepted';
            item.acceptedEventId = event.eventId;
          }
          connection.liveStatus = 'online';
          delete connection.lastError;
          delete connection.lastErrorCode;
        });
      } catch (error) {
        if (!(error instanceof ConnectorTransportError)) throw error;
        await this.persistence.transaction((state) => {
          const connection = requireConnection(state.connections[connectionId]);
          const item = connection.outbox.find((candidate) => candidate.outboxId === pending.outboxId);
          if (item) item.status = 'queued';
        });
        return this.markOffline(connectionId, error.message, error.causeCode);
      }
    }
  }

  private async acknowledgeContiguous(connectionId: string): Promise<ConnectorProjection> {
    const snapshot = requireConnection(this.persistence.snapshot().connections[connectionId]);
    const sequences = new Set(snapshot.inbox.map((item) => item.event.sequence));
    let sequence = snapshot.lastAckedSequence;
    while (sequences.has(sequence + 1)) sequence += 1;
    if (sequence === snapshot.lastAckedSequence) {
      return projectConnection(snapshot, this.persistence.snapshot().hostRoutes[connectionId]);
    }
    await this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      connection.pendingAckSequence = Math.max(connection.pendingAckSequence ?? 0, sequence);
    });
    return this.finishPendingAck(connectionId);
  }

  private async finishPendingAck(connectionId: string): Promise<ConnectorProjection> {
    const snapshot = requireConnection(this.persistence.snapshot().connections[connectionId]);
    const sequence = snapshot.pendingAckSequence;
    if (sequence === undefined) {
      return projectConnection(snapshot, this.persistence.snapshot().hostRoutes[connectionId]);
    }
    await this.service.acknowledge(snapshot.serviceUrl, requireCredential(snapshot), {
      serviceInstanceId: snapshot.serviceInstanceId,
      collectiveId: snapshot.collectiveId,
      connectionId: snapshot.connectionId,
      sequence,
    });
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      connection.lastAckedSequence = Math.max(connection.lastAckedSequence, sequence);
      delete connection.pendingAckSequence;
      connection.liveStatus = 'online';
      delete connection.lastError;
      delete connection.lastErrorCode;
      return projectConnection(connection, state.hostRoutes[connection.connectionId]);
    });
  }

  private async finishRevoke(connectionId: string): Promise<ConnectorProjection> {
    const persisted = this.persistence.snapshot();
    const snapshot = requireConnection(persisted.connections[connectionId]);
    if (snapshot.authorityStatus === 'revoked') {
      return projectConnection(snapshot, persisted.hostRoutes[connectionId]);
    }
    try {
      await this.service.revoke(snapshot.serviceUrl, requireCredential(snapshot), {
        serviceInstanceId: snapshot.serviceInstanceId,
        collectiveId: snapshot.collectiveId,
        connectionId: snapshot.connectionId,
      });
    } catch (error) {
      if (
        !(error instanceof ConnectorTransportError) ||
        error.statusCode !== 401 ||
        !error.message.toLowerCase().includes('revoked')
      ) {
        return this.markOffline(
          connectionId,
          error instanceof Error ? error.message : 'Revoke failed',
          error instanceof ConnectorTransportError ? error.causeCode : undefined,
        );
      }
    }
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      connection.authorityStatus = 'revoked';
      connection.revocationReason = 'owner_revoked';
      connection.liveStatus = 'offline';
      delete connection.endpointCredential;
      delete connection.lastError;
      delete connection.lastErrorCode;
      return projectConnection(connection, state.hostRoutes[connection.connectionId]);
    });
  }

  private async markOffline(connectionId: string, message: string, errorCode?: string): Promise<ConnectorProjection> {
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state.connections[connectionId]);
      connection.liveStatus = 'offline';
      connection.lastError = message;
      if (errorCode) connection.lastErrorCode = errorCode;
      else delete connection.lastErrorCode;
      return projectConnection(connection, state.hostRoutes[connection.connectionId]);
    });
  }
}

function requireConnection<Connection extends ConnectorConnectionState>(
  connection: Connection | undefined,
): Connection {
  if (!connection) throw new Error('Collective connection was not found');
  return connection;
}

function requireCredential(connection: ConnectorConnectionState): string {
  if (!connection.endpointCredential) throw new Error('Endpoint credential is unavailable');
  return connection.endpointCredential;
}
