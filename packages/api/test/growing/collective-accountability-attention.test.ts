import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import {
  type CollectiveAccountabilityAttentionItem,
  collectiveAccountabilityAttentionActionRef,
  collectiveAccountabilityAttentionSubjectRef,
} from '@cat-cafe/shared';
import { parseUnifiedCompanionSource } from '../../src/domains/concierge/live/host/unified/companion-unified-source.js';
import { readCollectiveAccountabilityAttentionSource } from '../../src/routes/companion-collective-accountability-source.js';
import { projectCompanionDecisions } from '../../src/routes/companion-decision-projection.js';

const ownerUserId = 'owner-user';
const serviceInstanceId = 'svc_aaaaaaaa';
const collectiveId = 'col_aaaaaaaa';
const sourceSnapshot = `sha256:${'a'.repeat(64)}`;

function connection(connectionId: string, humanId: string) {
  return {
    serviceUrl: 'http://collective.test',
    canonicalClientAnchor: {
      kind: 'collective-client',
      serviceUrl: 'http://collective.test',
      clientBuildId: 'test',
      serviceInstanceId,
      collectiveId,
      connectionId,
    },
    serviceInstanceId,
    collectiveId,
    connectionId,
    endpointId: `ep_${connectionId.slice(4)}`,
    authorizedHumanId: humanId,
    endpointLabel: connectionId,
    authorityStatus: 'connected' as const,
    liveStatus: 'online' as const,
    lastAckedSequence: 0,
    outbox: { queued: 0, accepted: 0 },
    route: { configured: true, revision: 1 },
    inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
  };
}

function route(localOwnerUserId: string) {
  return {
    localOwnerUserId,
    defaultIngressThreadId: 'thread-public',
    humanNotificationThreadId: 'thread-public',
    agentRoutes: {},
    standingInterests: {},
    revision: 1,
    updatedAt: '2026-10-18T12:00:00.000Z',
  };
}

function item(connectionId = 'con_owned0000', workRevision = 4): CollectiveAccountabilityAttentionItem {
  const identity = {
    serviceInstanceId,
    collectiveId,
    connectionId,
    workId: 'work_aaaaaaaa',
    accountabilityRequestId: 'accountability_aaaaaaaa',
  };
  return {
    producerId: 'f290.collective_work_accountability_request',
    subjectRef: collectiveAccountabilityAttentionSubjectRef(identity),
    ...identity,
    workRevision,
    expectedProducerRevision: workRevision,
    targetHumanId: 'human_owned0000',
    targetDisplayName: 'Owner Human',
    requestedByHumanId: 'human_requester0',
    requestedByDisplayName: 'Requester',
    requestEventId: 'evt_request0000',
    requestedAt: '2026-10-18T12:00:00.000Z',
    status: 'pending',
    roadmapId: 'roadmap_aaaaaaaa',
    projectTitle: 'Shared Project',
    channelId: 'general',
    workSourceEventId: 'evt_source00000',
    workTitle: 'Named responsibility',
    actionRef: collectiveAccountabilityAttentionActionRef({
      ...identity,
      workRevision,
      channelId: 'general',
      roadmapId: 'roadmap_aaaaaaaa',
    }),
  };
}

test('reads every page only from connections owned by this Host principal', async () => {
  const owned = connection('con_owned0000', 'human_owned0000');
  const foreign = connection('con_foreign000', 'human_foreign00');
  const calls: string[] = [];
  const connector = {
    async listConnections() {
      return [owned, foreign];
    },
    async getHostRoute(connectionId: string) {
      return connectionId === owned.connectionId ? route(ownerUserId) : route('another-owner');
    },
    async getProjection(connectionId: string) {
      return connectionId === owned.connectionId ? owned : foreign;
    },
    async readPendingAccountabilityRequests(connectionId: string, readOwner: string, page: { offset: number }) {
      calls.push(connectionId);
      assert.equal(readOwner, ownerUserId);
      assert.equal(connectionId, owned.connectionId);
      return {
        identity: {
          serviceInstanceId,
          collectiveId,
          connectionId,
          authorizedHumanId: owned.authorizedHumanId,
        },
        items: page.offset === 0 ? [item()] : [],
        page: {
          offset: page.offset,
          limit: 100,
          hasMore: page.offset === 0,
          snapshot: sourceSnapshot,
          totalCount: 1,
        },
      };
    },
  } as unknown as CollectiveConnector;

  const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  assert.deepEqual(calls, [owned.connectionId, owned.connectionId]);
  assert.equal(read.state.status, 'available');
  assert.equal(read.state.exhaustiveness, 'complete');
  assert.deepEqual(read.items, [item()]);
  assert.deepEqual(read.reasons, []);
});

test('keeps successful rows but marks the source partial when any owned connection fails', async () => {
  const first = connection('con_owned0000', 'human_owned0000');
  const second = connection('con_owned0001', 'human_owned0001');
  const routes = new Map([
    [first.connectionId, route(ownerUserId)],
    [second.connectionId, route(ownerUserId)],
  ]);
  const connector = {
    async listConnections() {
      return [first, second];
    },
    async getHostRoute(connectionId: string) {
      return routes.get(connectionId);
    },
    async getProjection(connectionId: string) {
      return connectionId === first.connectionId ? first : second;
    },
    async readPendingAccountabilityRequests(connectionId: string) {
      if (connectionId === second.connectionId) throw new Error('second Service unavailable');
      return {
        identity: {
          serviceInstanceId,
          collectiveId,
          connectionId,
          authorizedHumanId: first.authorizedHumanId,
        },
        items: [item(first.connectionId)],
        page: { offset: 0, limit: 100, hasMore: false, snapshot: sourceSnapshot, totalCount: 1 },
      };
    },
  } as unknown as CollectiveConnector;

  const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  assert.equal(read.state.status, 'available');
  assert.equal(read.state.exhaustiveness, 'partial');
  assert.deepEqual(read.items, [item(first.connectionId)]);
  assert.ok(read.reasons.includes('collective_accountability_connection_read_failed'));
});

test('drops a late response when the endpoint Human or Host route changes before projection', async () => {
  const before = connection('con_owned0000', 'human_owned0000');
  const after = { ...before, authorizedHumanId: 'human_rebound000' };
  let projectionReads = 0;
  const connector = {
    async listConnections() {
      return [before];
    },
    async getHostRoute() {
      return projectionReads > 0 ? { ...route(ownerUserId), revision: 2 } : route(ownerUserId);
    },
    async getProjection() {
      projectionReads += 1;
      return after;
    },
    async readPendingAccountabilityRequests() {
      return {
        identity: {
          serviceInstanceId,
          collectiveId,
          connectionId: before.connectionId,
          authorizedHumanId: before.authorizedHumanId,
        },
        items: [item()],
        page: { offset: 0, limit: 100, hasMore: false, snapshot: sourceSnapshot, totalCount: 1 },
      };
    },
  } as unknown as CollectiveConnector;

  const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  assert.deepEqual(read.items, []);
  assert.equal(read.state.exhaustiveness, 'partial');
  assert.ok(read.reasons.includes('collective_accountability_authority_changed'));
});

test('does not report complete coverage when a later Service page loses its source snapshot', async () => {
  const owned = connection('con_owned0000', 'human_owned0000');
  let reads = 0;
  const connector = {
    async listConnections() {
      return [owned];
    },
    async getHostRoute() {
      return route(ownerUserId);
    },
    async getProjection() {
      return owned;
    },
    async readPendingAccountabilityRequests(
      connectionId: string,
      readOwner: string,
      page: { offset: number; snapshot?: string },
    ) {
      assert.equal(connectionId, owned.connectionId);
      assert.equal(readOwner, ownerUserId);
      reads += 1;
      if (reads === 2) {
        assert.equal(page.snapshot, sourceSnapshot);
        throw Object.assign(new Error('pending source changed'), { statusCode: 409 });
      }
      return {
        identity: {
          serviceInstanceId,
          collectiveId,
          connectionId,
          authorizedHumanId: owned.authorizedHumanId,
        },
        items: [item()],
        page: { offset: 0, limit: 100, hasMore: true, snapshot: sourceSnapshot, totalCount: 101 },
      };
    },
  } as unknown as CollectiveConnector;

  const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  assert.equal(read.items.length, 0);
  assert.equal(read.state.status, 'unavailable');
  assert.equal(read.state.exhaustiveness, 'partial');
  assert.ok(read.reasons.includes('collective_accountability_connection_read_failed'));
});

test('projects only the typed pending request as a qualified personal decision and versions its presentation', () => {
  const source = (
    coverage:
      | 'all_registered_F246_producers'
      | 'current_linked_F310_five_producers'
      | 'pending_f306_structured_choices',
  ) => ({
    status: 'available' as const,
    startedAt: 1,
    observedAt: 2,
    coverage,
    exhaustiveness: 'complete' as const,
  });
  const project = (attentionItem: CollectiveAccountabilityAttentionItem, exhaustiveness: 'complete' | 'partial') =>
    projectCompanionDecisions(
      { items: [], coverage: { state: 'complete' } },
      { ownerReads: [], coverage: { state: 'complete' } },
      ownerUserId,
      { offset: 0, limit: 20 },
      3,
      {
        approvals: source('all_registered_F246_producers'),
        needsMe: source('current_linked_F310_five_producers'),
        structuredChoices: source('pending_f306_structured_choices'),
      },
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      {
        items: [attentionItem],
        reasons: [],
        state: {
          status: 'available',
          startedAt: 1,
          observedAt: 2,
          coverage: 'pending_f290_collective_accountability_requests',
          exhaustiveness,
        },
      },
    );
  const current = project(item(), 'complete');
  assert.equal(current.status, 'available');
  assert.equal(current.totalCount, 1);
  assert.equal(current.attentionCount, 1);
  assert.equal(current.sources.collectiveAccountabilityRequests?.exhaustiveness, 'complete');
  assert.deepEqual(current.items[0]?.collectiveAccountabilityRequest, item());
  assert.equal(current.items[0]?.kind, 'judgment');
  assert.ok(current.items[0]?.preferenceCoordinate);
  assert.deepEqual(
    parseUnifiedCompanionSource(current, ownerUserId, { offset: 0, limit: 20 }).items[0]
      ?.collectiveAccountabilityRequest,
    item(),
  );

  const next = project(item('con_owned0000', 5), 'complete');
  assert.equal(next.items[0]?.decisionRef, current.items[0]?.decisionRef);
  assert.notEqual(next.items[0]?.preferenceCoordinate?.version, current.items[0]?.preferenceCoordinate?.version);

  const partial = project(item(), 'partial');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.totalCount, undefined);
  assert.equal(partial.attentionCount, undefined);
});
