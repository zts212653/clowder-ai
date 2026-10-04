import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { setChannelListening } from '../channel-listening-custody.js';
import { hostRouteConfigSchema } from '../host-route-state.js';
import { ConnectorPersistence } from '../persistence.js';

it('persists a single owner-selected duty Cat independently of route and work authority, with fenced edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-channel-listening-'));
  const persistence = await ConnectorPersistence.open(directory);
  try {
    await persistence.transaction((state) => {
      state.connections.cafe = {
        serviceUrl: 'http://127.0.0.1:5100',
        clientBuildId: 'test',
        serviceInstanceId: 'svc_aaaaaaaa',
        collectiveId: 'col_aaaaaaaa',
        connectionId: 'cafe',
        endpointId: 'ep_aaaaaaaa',
        endpointLabel: 'Fixture',
        authorizedHumanId: 'human_aaaaaaaa',
        endpointCredential: 'fixture-credential',
        authorityStatus: 'connected',
        liveStatus: 'online',
        lastAckedSequence: 0,
        outbox: [],
        inbox: [],
        createdAt: new Date(0).toISOString(),
      };
      state.hostRoutes.cafe = hostRouteConfigSchema.parse({
        connectionId: 'cafe',
        localOwnerUserId: 'owner',
        defaultIngressThreadId: 'receiver',
        humanNotificationThreadId: 'owner-room',
        agentRoutes: {},
        channelRoutes: {
          general: {
            channelId: 'general',
            threadId: 'receiver',
            participants: { sol: { displayName: 'Sol' }, astra: { displayName: 'Astra' } },
          },
        },
        revision: 4,
        updatedAt: new Date(0).toISOString(),
      });
    });
    const before = persistence.snapshot().connections.cafe;
    const set = (unsafeInput: Parameters<typeof setChannelListening>[0]['unsafeInput'], ownerUserId = 'owner') =>
      setChannelListening({ persistence, now: () => 1000, connectionId: 'cafe', ownerUserId, unsafeInput });
    await expect(
      set({ channelId: 'general', mode: 'all', dutyCatId: 'sol', expectedAttentionRevision: 0 }, 'guest'),
    ).rejects.toMatchObject({ code: 'CONNECTOR_OWNER_MISMATCH' });
    await expect(
      set({ channelId: 'general', mode: 'all', dutyCatId: 'missing', expectedAttentionRevision: 0 }),
    ).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
    const enabled = await set({ channelId: 'general', mode: 'all', dutyCatId: 'sol', expectedAttentionRevision: 0 });
    expect(enabled).toMatchObject({
      revision: 4,
      attentionRevision: 1,
      channelListening: { general: { mode: 'all', dutyCatId: 'sol' } },
    });
    expect(persistence.snapshot().connections.cafe).toEqual(before);
    expect((await ConnectorPersistence.open(directory)).snapshot().hostRoutes.cafe.channelListening).toEqual(
      enabled.channelListening,
    );
    await expect(set({ channelId: 'general', mode: 'mentions', expectedAttentionRevision: 0 })).rejects.toMatchObject({
      code: 'ATTENTION_REVISION_CONFLICT',
    });
    const mentions = await set({ channelId: 'general', mode: 'mentions', expectedAttentionRevision: 1 });
    expect(mentions).toMatchObject({
      revision: 4,
      attentionRevision: 2,
      channelListening: { general: { mode: 'mentions' } },
    });
    expect(
      (await set({ channelId: 'general', mode: 'mentions', expectedAttentionRevision: 2 })).attentionRevision,
    ).toBe(2);
  } finally {
    await rm(directory, { recursive: true });
  }
});
