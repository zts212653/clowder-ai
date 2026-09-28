import { isDeepStrictEqual } from 'node:util';
import {
  type CollectivePairingIntent,
  type CollectiveSourceIdentity,
  collectivePairingIntentSchema,
} from '@cat-cafe/shared';

import { type ConnectorSyncHooks, ConnectorSynchronization } from './connector-synchronization.js';
import { prepareReplyOperation, queueVerifiedAgentMessage, submitReplyOperation } from './outbox-custody.js';
import { participationDeclaration, requireParticipation } from './participation-custody.js';
import { ConnectorPersistence } from './persistence.js';
import { type ConnectorProjection, projectConnection } from './projection.js';
import {
  beginInboxRouting,
  completeInboxRouting,
  failInboxRouting,
  getHostRoute,
  listInboxForRouting,
  setHostRoute,
} from './route-custody.js';
import { CollectiveServiceClient } from './service-client.js';
import {
  type ConnectorConnectionState,
  type ConnectorInboxItem,
  type ConnectorRouteFailure,
  type ConnectorRouteReceipt,
  type HostRouteConfig,
  type SetHostRouteInput,
  type VerifiedAgent,
} from './state.js';

export interface CollectiveConnectorOptions {
  readonly dataDirectory: string;
  readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export type { ConnectorSyncHooks } from './connector-synchronization.js';

export class CollectiveConnector {
  private readonly synchronization: ConnectorSynchronization;
  private readonly authorityTails = new Map<string, Promise<void>>();

  private constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
    private readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>,
    private readonly now: () => number,
  ) {
    this.synchronization = new ConnectorSynchronization(persistence, service, now);
  }

  static async open(options: CollectiveConnectorOptions): Promise<CollectiveConnector> {
    return new CollectiveConnector(
      await ConnectorPersistence.open(options.dataDirectory),
      new CollectiveServiceClient(options.fetchImpl),
      options.verifyAgent,
      options.now ?? Date.now,
    );
  }

  async pair(input: {
    serviceUrl: string;
    intent: CollectivePairingIntent;
    endpointLabel: string;
  }): Promise<ConnectorProjection> {
    const intent = collectivePairingIntentSchema.parse(input.intent);
    const serviceUrl = new URL(input.serviceUrl).origin;
    const metadata = await this.service.readMetadata(serviceUrl);
    if (metadata.serviceInstanceId !== intent.serviceInstanceId) {
      throw new Error('Pairing intent belongs to another Collective Service');
    }
    const paired = await this.service.exchangePairing(serviceUrl, intent, input.endpointLabel);
    if (paired.serviceInstanceId !== intent.serviceInstanceId || paired.collectiveId !== intent.collectiveId) {
      throw new Error('Pairing response coordinates do not match the intent');
    }
    const connection: ConnectorConnectionState = {
      serviceUrl,
      clientBuildId: metadata.clientBuildId,
      serviceInstanceId: paired.serviceInstanceId,
      collectiveId: paired.collectiveId,
      connectionId: paired.connectionId,
      endpointId: paired.endpointId,
      authorizedHumanId: paired.authorizedHumanId,
      endpointLabel: input.endpointLabel.trim(),
      endpointCredential: paired.endpointCredential,
      authorityStatus: 'connected',
      liveStatus: 'online',
      lastAckedSequence: 0,
      outbox: [],
      inbox: [],
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.persistence.transaction((state) => {
      state.connections[connection.connectionId] = connection;
    });
    return projectConnection(connection);
  }

  async queueAgentMessage(connectionId: string, unsafeInput: unknown): Promise<ConnectorProjection> {
    return queueVerifiedAgentMessage({
      persistence: this.persistence,
      verifyAgent: this.verifyAgent,
      now: this.now,
      connectionId,
      unsafeInput,
    });
  }

  sync(connectionId: string, hooks: ConnectorSyncHooks = {}): Promise<ConnectorProjection> {
    return this.withAuthority(connectionId, () => this.synchronization.sync(connectionId, hooks));
  }

  async revoke(connectionId: string): Promise<ConnectorProjection> {
    return this.withAuthority(connectionId, () => this.synchronization.revoke(connectionId));
  }

  async getProjection(connectionId: string): Promise<ConnectorProjection> {
    const snapshot = this.persistence.snapshot();
    return projectConnection(requireConnection(snapshot.connections[connectionId]), snapshot.hostRoutes[connectionId]);
  }

  async listConnections(): Promise<ConnectorProjection[]> {
    const snapshot = this.persistence.snapshot();
    return Object.values(snapshot.connections).map((connection) =>
      projectConnection(connection, snapshot.hostRoutes[connection.connectionId]),
    );
  }

  async listInbox(connectionId: string) {
    const connection = requireConnection(this.persistence.snapshot().connections[connectionId]);
    return structuredClone(connection.inbox);
  }

  async setHostRoute(
    connectionId: string,
    unsafeInput: SetHostRouteInput,
    expectedRevision?: number,
  ): Promise<HostRouteConfig> {
    return this.withAuthority(connectionId, () =>
      setHostRoute({
        persistence: this.persistence,
        now: this.now,
        connectionId,
        unsafeInput,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    );
  }

  async publishParticipation(connectionId: string): Promise<void> {
    return this.withAuthority(connectionId, async () => {
      const state = this.persistence.snapshot();
      const connection = requireConnection(state.connections[connectionId]);
      const route = state.hostRoutes[connectionId];
      if (!route || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
        throw new Error('Participation is not configured');
      await this.service.publishParticipation(
        connection.serviceUrl,
        connection.endpointCredential,
        participationDeclaration(connection, route),
      );
    });
  }

  /** Linearizes accepted public effects with local binding changes and endpoint revocation. */
  private async withAuthority<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.authorityTails.get(connectionId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.authorityTails.set(connectionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.authorityTails.get(connectionId) === current) this.authorityTails.delete(connectionId);
    }
  }

  async isParticipationPublished(connectionId: string): Promise<boolean> {
    const state = this.persistence.snapshot();
    const connection = requireConnection(state.connections[connectionId]);
    const route = state.hostRoutes[connectionId];
    if (!route || connection.authorityStatus !== 'connected' || !connection.endpointCredential) return false;
    const declaration = await this.service.readParticipationDeclaration(
      connection.serviceUrl,
      connection.endpointCredential,
      {
        serviceInstanceId: connection.serviceInstanceId,
        collectiveId: connection.collectiveId,
        connectionId,
      },
    );
    return (
      isDeepStrictEqual(declaration, participationDeclaration(connection, route)) &&
      this.persistence.snapshot().hostRoutes[connectionId]?.revision === route.revision
    );
  }

  async readParticipationContext(source: CollectiveSourceIdentity, afterSequence = 0, limit = 30) {
    const { connection, credential } = requireParticipation(this.persistence.snapshot(), source);
    const context = await this.service.readParticipationContext(
      connection.serviceUrl,
      credential,
      source,
      afterSequence,
      limit,
    );
    requireParticipation(this.persistence.snapshot(), source);
    if (
      context.source.eventId !== source.eventId ||
      context.source.serviceInstanceId !== source.serviceInstanceId ||
      context.source.collectiveId !== source.collectiveId ||
      !isDeepStrictEqual(context.source.location, source.location) ||
      !isDeepStrictEqual(context.source.actor, source.actor)
    )
      throw new Error('Collective source identity changed');
    return context;
  }

  prepareReply(source: CollectiveSourceIdentity, sourceRef: string, resultKey: string, workRevision?: number) {
    return prepareReplyOperation({
      persistence: this.persistence,
      now: this.now,
      source,
      sourceRef,
      resultKey,
      ...(workRevision ? { workRevision } : {}),
    });
  }

  async submitReply(
    source: CollectiveSourceIdentity,
    sourceRef: string,
    resultKey: string,
    operationId: string,
    body: string,
    agent: VerifiedAgent,
  ) {
    await this.readParticipationContext(source, 0, 1);
    return submitReplyOperation({
      persistence: this.persistence,
      now: this.now,
      source,
      sourceRef,
      resultKey,
      operationId,
      body,
      agent,
      verifyAgent: this.verifyAgent,
    });
  }

  async getHostRoute(connectionId: string): Promise<HostRouteConfig | undefined> {
    return getHostRoute(this.persistence, connectionId);
  }

  async listInboxForRouting(connectionId: string): Promise<ConnectorInboxItem[]> {
    return listInboxForRouting(this.persistence, connectionId);
  }

  async beginInboxRouting(
    connectionId: string,
    eventId: string,
    routeConfigRevision: number,
  ): Promise<ConnectorInboxItem> {
    return beginInboxRouting({
      persistence: this.persistence,
      now: this.now,
      connectionId,
      eventId,
      routeConfigRevision,
    });
  }

  async completeInboxRouting(
    connectionId: string,
    eventId: string,
    routeConfigRevision: number,
    receipt: ConnectorRouteReceipt,
  ): Promise<ConnectorInboxItem> {
    return completeInboxRouting({
      persistence: this.persistence,
      now: this.now,
      connectionId,
      eventId,
      routeConfigRevision,
      receipt,
    });
  }

  async failInboxRouting(
    connectionId: string,
    eventId: string,
    routeConfigRevision: number,
    failure: ConnectorRouteFailure,
  ): Promise<ConnectorInboxItem> {
    return failInboxRouting({
      persistence: this.persistence,
      connectionId,
      eventId,
      routeConfigRevision,
      failure,
    });
  }
}

function requireConnection<Connection extends ConnectorConnectionState>(
  connection: Connection | undefined,
): Connection {
  if (!connection) throw new Error('Collective connection was not found');
  return connection;
}
