import { type CollectivePairingIntent, collectivePairingIntentSchema } from '@cat-cafe/shared';

import { type ConnectorSyncHooks, ConnectorSynchronization } from './connector-synchronization.js';
import { queueVerifiedAgentMessage } from './outbox-custody.js';
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
    return this.synchronization.sync(connectionId, hooks);
  }

  async revoke(connectionId: string): Promise<ConnectorProjection> {
    return this.synchronization.revoke(connectionId);
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

  async setHostRoute(connectionId: string, unsafeInput: SetHostRouteInput): Promise<HostRouteConfig> {
    return setHostRoute({ persistence: this.persistence, now: this.now, connectionId, unsafeInput });
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
