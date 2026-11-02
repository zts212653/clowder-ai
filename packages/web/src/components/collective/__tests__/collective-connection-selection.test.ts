import { describe, expect, it } from 'vitest';
import type { CollectiveConnectionProjection } from '../collective-client';
import { preferredConnection } from '../collective-connection-selection';

function connection(
  connectionId: string,
  options: Partial<CollectiveConnectionProjection> = {},
): CollectiveConnectionProjection {
  const serviceUrl = options.serviceUrl ?? 'http://localhost:5201';
  const serviceInstanceId = options.serviceInstanceId ?? 'svc_12345678';
  const collectiveId = options.collectiveId ?? `col_${connectionId}`;
  return {
    serviceUrl,
    canonicalClientAnchor: {
      kind: 'collective-client',
      serviceUrl,
      serviceInstanceId,
      collectiveId,
      connectionId,
      clientBuildId: 'test-build',
    },
    serviceInstanceId,
    collectiveId,
    connectionId,
    endpointId: `ep_${connectionId}`,
    endpointLabel: connectionId,
    authorityStatus: 'connected',
    liveStatus: 'offline',
    lastAckedSequence: 0,
    outbox: { queued: 0, accepted: 0 },
    route: { configured: false },
    inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
    ...options,
  };
}

describe('preferred Collective connection', () => {
  it('honours an explicit in-session selection even when another endpoint is online', () => {
    const selected = connection('con_selected', { liveStatus: 'offline' });
    const online = connection('con_online', { liveStatus: 'online' });

    expect(preferredConnection([online, selected], selected.connectionId)).toBe(selected);
  });

  it('chooses an online usable endpoint without showing a daily connection decision', () => {
    const offline = connection('con_offline');
    const online = connection('con_online', { liveStatus: 'online' });

    expect(preferredConnection([offline, online])).toBe(online);
  });

  it('uses a stable identity order when several usable endpoints have the same liveness', () => {
    const later = connection('con_z', { liveStatus: 'online', serviceUrl: 'https://z.example.test' });
    const earlier = connection('con_a', { liveStatus: 'online', serviceUrl: 'https://a.example.test' });

    expect(preferredConnection([later, earlier])).toBe(earlier);
    expect(preferredConnection([earlier, later])).toBe(earlier);
  });

  it('keeps a sole revoked record reachable for its existing repair experience', () => {
    const revoked = connection('con_revoked', { authorityStatus: 'revoked' });

    expect(preferredConnection([revoked])).toBe(revoked);
  });
});
