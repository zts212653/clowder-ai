import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeetingIntake } from '@cat-cafe/shared';
import { F292ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F292ApprovalAdapter.js';
import { F292NeedsMeProducerAdapter } from '../../src/domains/growing/NeedsMeProducerAdapter.js';

function intake(id: string, kind: string): MeetingIntake {
  return {
    intakeId: id,
    ownerId: 'owner',
    routeId: 'route',
    routeGeneration: 1,
    origin: {
      pluginId: 'feishu',
      pluginInstanceId: 'one',
      packageDigest: 'digest',
      contractVersion: '1',
      signalType: 'meeting',
      declaration: { epistemicStatus: 'observation', privacyClass: 'content-adjacent', sourceClass: 'remote-service' },
    },
    source: { handle: `feishu://meeting-artifacts/${kind}/${id}` },
    occurredAt: '2026-09-30T00:00:00Z',
    metadata: { artifactKind: kind, meetingId: 'meeting', title: 'Weekly', revision: 'generation' },
    ingress: { publicationId: id, eventId: id, idempotencyKey: id, canonicalDigest: id, firstDeliveredAt: 1 },
    entrustedWorkTaskRef: { subjectRef: 'task:work:one', observedRevision: 3 },
    sourceState: 'ready',
    judgmentState: 'unresolved',
    executionState: 'idle',
    healthState: 'healthy',
    unresolved: ['context'],
    choices: {},
    revision: 5,
    createdAt: 10,
    updatedAt: 20,
  };
}

test('F292 attention list uses the same canonical meeting as approval; closing it retires sibling noise without writes', async () => {
  let rows = [intake('minute', 'minute'), intake('note', 'note')];
  const store = { list: async () => rows, get: async (id: string) => rows.find((row) => row.intakeId === id) ?? null };
  const producer = new F292NeedsMeProducerAdapter(store);
  assert.deepEqual(
    (await producer.listCurrentReceipts('owner')).map((row) => row.producer.subjectRef),
    ['minute'],
  );
  assert.deepEqual(await producer.listCurrentReceipts('other'), []);
  const approvals = new F292ApprovalAdapter(store as ConstructorParameters<typeof F292ApprovalAdapter>[0]);
  assert.deepEqual((await approvals.listPending('owner'))[0].needsMeDecisionRefs, [
    { producerId: 'f292.repair', subjectRef: 'minute', revision: 5 },
    { producerId: 'f292.repair', subjectRef: 'note', revision: 5 },
  ]);
  rows = [
    { ...rows[0], judgmentState: 'confirmed', executionState: 'succeeded', revision: 6, unresolved: [] },
    rows[1],
  ];
  assert.deepEqual(await producer.listCurrentReceipts('owner'), []);
  assert.deepEqual(await approvals.listPending('owner'), []);
});
