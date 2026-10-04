import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostRouteConfig } from '@cat-cafe/collective-connector';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { reconcileParticipation } from '../src/domains/plugin/builtin-runtime/collective-participation-reconciler.js';

/** Production reconciler/ThreadStore; the route writer is an in-memory adapter, not Service auth or a model. */
test('ten authorized Collectives times ten Channels retain 100 logical endpoints as Cats are added or renamed', async () => {
  const threads = new ThreadStore();
  const routes = new Map<string, HostRouteConfig>();
  const publications: string[] = [];
  const connector: Parameters<typeof reconcileParticipation>[0]['connector'] = {
    async setHostRoute(connectionId, input, expectedRevision) {
      assert.ok(expectedRevision !== undefined);
      assert.equal(routes.get(connectionId)?.revision ?? 0, expectedRevision);
      const route: HostRouteConfig = {
        ...input,
        connectionId,
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
        desiredParticipation: input.desiredParticipation ?? {
          defaultMode: 'include',
          excludedCatIds: [],
          channelOverrides: {},
        },
        observedEligibility: input.observedEligibility ?? {},
        publicProfiles: {},
        channelRoutes: input.channelRoutes ?? {},
        standingInterests: input.standingInterests ?? {},
        scopeStarts: {},
        attentionRevision: input.attentionRevision ?? 0,
      };
      routes.set(connectionId, route);
      return route;
    },
    async publishParticipation(connectionId) {
      publications.push(connectionId);
    },
  };
  const channelIds = Array.from({ length: 10 }, (_, i) => `authorized-${i}`);
  const cats = [
    { id: 'codex-sol', displayName: 'Same Cat', supported: true },
    { id: 'codex-terra', displayName: 'Same Cat', supported: true },
    { id: 'opus', displayName: 'Unsupported Cat', supported: false },
  ];
  const endpointIds = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const route = await reconcileParticipation({
      connector,
      threads,
      connectionId: `collective-${i}`,
      ownerUserId: 'owner',
      expectedRevision: 0,
      channelIds,
      cats,
    });
    assert.equal(Object.keys(route.channelRoutes).length, 10);
    assert.equal(Object.keys(route.agentRoutes).length, 0, 'Cats do not create per-Cat endpoints');
    for (const endpoint of Object.values(route.channelRoutes)) {
      endpointIds.add(endpoint.threadId);
      assert.deepEqual(Object.keys(endpoint.participants), ['codex-sol', 'codex-terra']);
      assert.equal(threads.get(endpoint.threadId)?.createdBy, 'owner');
    }
  }
  assert.equal(endpointIds.size, 100);
  assert.equal(threads.list('owner').length, 100);
  for (const [connectionId, route] of routes) {
    const next = await reconcileParticipation({
      connector,
      threads,
      connectionId,
      ownerUserId: 'owner',
      route,
      expectedRevision: route.revision,
      channelIds,
      cats: [
        ...cats.map((cat) => ({ ...cat, displayName: `Renamed ${cat.id}` })),
        { id: 'codex61-sol', displayName: 'New Cat', supported: true },
      ],
    });
    assert.deepEqual(
      Object.values(next.channelRoutes).map((endpoint) => endpoint.threadId),
      Object.values(route.channelRoutes).map((endpoint) => endpoint.threadId),
    );
    assert.equal(next.channelRoutes['not-authorized'], undefined);
    for (const endpoint of Object.values(next.channelRoutes)) {
      assert.deepEqual(Object.keys(endpoint.participants), ['codex-sol', 'codex-terra', 'codex61-sol']);
    }
  }
  assert.equal(threads.list('owner').length, 100, 'Profile edits and another Cat retain the same Channel endpoints');
  assert.equal(publications.length, 20);
});
