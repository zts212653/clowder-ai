import type { CollectiveClientAnchor } from '@cat-cafe/shared';

import type { ConnectorConnectionState, HostRouteConfig } from './state.js';

export interface ConnectorProjection {
  readonly serviceUrl: string;
  readonly canonicalClientAnchor: CollectiveClientAnchor;
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly connectionId: string;
  readonly endpointId: string;
  readonly authorizedHumanId?: string;
  readonly endpointLabel: string;
  readonly authorityStatus: 'connected' | 'revoking' | 'revoked';
  readonly revocationReason?: 'owner_revoked' | 'identity_rebind_required';
  readonly liveStatus: 'online' | 'offline';
  readonly lastAckedSequence: number;
  readonly outbox: { readonly queued: number; readonly accepted: number };
  readonly route: { readonly configured: boolean; readonly revision?: number };
  readonly inbox: {
    readonly persisted: number;
    readonly pending: number;
    readonly routed: number;
    readonly failed: number;
    readonly latestFailure?: { readonly code: string; readonly message: string };
  };
  readonly lastError?: string;
  readonly lastErrorCode?: string;
}

export function projectConnection(connection: ConnectorConnectionState, route?: HostRouteConfig): ConnectorProjection {
  const latestFailure = [...connection.inbox]
    .reverse()
    .find((item) => item.disposition === 'route_failed')?.routeFailure;
  return {
    serviceUrl: connection.serviceUrl,
    canonicalClientAnchor: {
      kind: 'collective-client',
      serviceUrl: connection.serviceUrl,
      clientBuildId: connection.clientBuildId,
      serviceInstanceId: connection.serviceInstanceId,
      collectiveId: connection.collectiveId,
      connectionId: connection.connectionId,
    },
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
    endpointId: connection.endpointId,
    ...(connection.authorizedHumanId ? { authorizedHumanId: connection.authorizedHumanId } : {}),
    endpointLabel: connection.endpointLabel,
    authorityStatus: connection.authorityStatus,
    ...(connection.revocationReason ? { revocationReason: connection.revocationReason } : {}),
    liveStatus: connection.liveStatus,
    lastAckedSequence: connection.lastAckedSequence,
    outbox: {
      queued: connection.outbox.filter((item) => item.status !== 'accepted').length,
      accepted: connection.outbox.filter((item) => item.status === 'accepted').length,
    },
    route: {
      configured: route !== undefined,
      ...(route ? { revision: route.revision } : {}),
    },
    inbox: {
      persisted: connection.inbox.length,
      pending: connection.inbox.filter((item) => item.disposition === 'persisted' || item.disposition === 'routing')
        .length,
      routed: connection.inbox.filter((item) => item.disposition === 'routed').length,
      failed: connection.inbox.filter((item) => item.disposition === 'route_failed').length,
      ...(latestFailure ? { latestFailure: structuredClone(latestFailure) } : {}),
    },
    ...(connection.lastError ? { lastError: connection.lastError } : {}),
    ...(connection.lastErrorCode ? { lastErrorCode: connection.lastErrorCode } : {}),
  };
}
