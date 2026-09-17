import type { CollectiveClientAnchor } from '@cat-cafe/shared';

export type { CollectivePairingIntentMessage } from '@cat-cafe/shared';

export interface CollectiveConnectionProjection {
  readonly serviceUrl: string;
  readonly canonicalClientAnchor: CollectiveClientAnchor;
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly connectionId: string;
  readonly endpointId: string;
  readonly endpointLabel: string;
  readonly authorityStatus: 'connected' | 'revoking' | 'revoked';
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
}

export interface CollectiveConnectorStatus {
  readonly runtimeStatus: 'active' | 'inactive';
  readonly connections: readonly CollectiveConnectionProjection[];
  readonly localService?: LocalCollectiveServiceStatus;
}

export interface LocalCollectiveServiceStatus {
  readonly state: 'not_created' | 'stopped' | 'starting' | 'setup_required' | 'ready' | 'error';
  readonly serviceUrl: string;
  readonly dataDirectory: string;
  readonly serviceInstanceId?: string;
  readonly bootstrapNeeded?: boolean;
  readonly setupStep?: 'github_app' | 'owner_setup';
  readonly error?: string;
}

export interface LocalCollectiveServiceLaunch {
  readonly service: LocalCollectiveServiceStatus;
  readonly launchUrl: string;
}

export function normalizeCollectiveServiceUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function canonicalClientUrl(serviceUrl: string, hostOrigin: string): string {
  const source = new URL(serviceUrl);
  const bootstrapHash = source.hash;
  const url = new URL('/', source.origin);
  url.searchParams.set('hostOrigin', hostOrigin);
  url.hash = bootstrapHash;
  return url.toString();
}
