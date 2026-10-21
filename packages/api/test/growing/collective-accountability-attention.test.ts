import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CollectiveAccountabilityAttentionItem,
  collectiveAccountabilityAttentionActionRef,
  collectiveAccountabilityAttentionSubjectRef,
} from '@cat-cafe/shared';
import { parseUnifiedCompanionSource } from '../../src/domains/concierge/live/host/unified/companion-unified-source.js';
import { projectCompanionDecisions } from '../../src/routes/companion-decision-projection.js';

const ownerUserId = 'owner-user';
const serviceInstanceId = 'svc_aaaaaaaa';
const collectiveId = 'col_aaaaaaaa';

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
