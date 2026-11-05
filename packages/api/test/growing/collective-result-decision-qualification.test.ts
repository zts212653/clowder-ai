import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntrustedWorkOwnerReadV1, IgnoredItemSnapshot, UnifiedAttentionSourceRead } from '@cat-cafe/shared';
import { projectCompanionDecisions } from '../../src/routes/companion-decision-projection.js';

const ownerUserId = 'owner';
const taskSubjectRef = 'task:work:task-result';
const taskOwnerRef = 'task:item:task-result';
const producerSubjectRef = 'collective-result:con_aaaaaaaa:work_aaaaaaaa';

const source = (coverage: UnifiedAttentionSourceRead['coverage']): UnifiedAttentionSourceRead => ({
  status: 'available',
  exhaustiveness: 'complete',
  startedAt: 1,
  observedAt: 2,
  coverage,
});

function collectiveResultOwnerRead(): EntrustedWorkOwnerReadV1 {
  const evidence = [
    {
      producerId: 'f290.collective_work_result' as const,
      ownerRef: producerSubjectRef,
      revision: 4,
    },
  ];
  return {
    envelope: {
      subjectRef: taskSubjectRef,
      ownerRef: taskOwnerRef,
      admissionReceiptRef: 'task:receipt:collective-result',
      sourceRefs: ['message:collective-source'],
      revision: 8,
      freshness: { state: 'current', observedRevision: 8 },
      visibility: { ownerUserId, human: true, cat: true },
    },
    brief: {
      outcome: { state: 'known', value: 'Review the Collective result', ownerRef: taskOwnerRef, revision: 8 },
      current: { state: 'doing', ownerRef: taskOwnerRef, revision: 8 },
      verifiedMilestone: { kind: 'needs_judgment', evidenceRef: producerSubjectRef, revision: 4 },
      nextOwner: { kind: 'human', ownerRef: `user:${ownerUserId}`, evidence },
      needsMe: { state: 'needed', evidence },
    },
    work: {
      title: 'Prepare the Collective result',
      ownerCatId: 'codex-sol',
      threadId: 'thread-private',
      admittedAt: 1,
      ownerNote: '',
    },
    preparedArtifact: {
      artifactRef: 'artifact:result',
      artifactRevision: '1',
      completenessRef: 'artifact:result#complete:1',
      previewRef: 'artifact:result#preview:1',
      openInWorkspaceRef: 'workspace:artifact:thread-private:1:artifact:result',
    },
    timeRefs: [],
    attentionReceipts: [
      {
        eligible: true,
        producer: {
          producerId: 'f290.collective_work_result',
          ownerRef: producerSubjectRef,
          subjectRef: producerSubjectRef,
          revision: 4,
        },
        taskRef: { subjectRef: taskSubjectRef, observedRevision: 8 },
        kind: 'judgment',
        reasonCode: 'collective_result_ready',
        recommendation: 'Review the prepared result in its Collective Work',
        salience: 'normal',
        action: {
          actionRef:
            '/collective?connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&resultEventId=evt_result0000&resultRevision=2',
          expectedProducerRevision: 4,
        },
        reEvaluateActionRef: `${producerSubjectRef}#reevaluate`,
      },
    ],
  };
}

function project(
  ownerRead: EntrustedWorkOwnerReadV1,
  personal?: { mode: 'visible' | 'ignored'; snapshot: IgnoredItemSnapshot; state: UnifiedAttentionSourceRead },
) {
  return projectCompanionDecisions(
    { items: [], coverage: { state: 'complete' } },
    { ownerReads: [ownerRead], coverage: { state: 'complete' } },
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
    personal,
  );
}

function mutateOwnerRead(mutator: (ownerRead: EntrustedWorkOwnerReadV1) => void): EntrustedWorkOwnerReadV1 {
  const ownerRead = collectiveResultOwnerRead();
  mutator(ownerRead);
  return ownerRead;
}

function resultReceipt(ownerRead: EntrustedWorkOwnerReadV1) {
  const receipt = ownerRead.attentionReceipts[0];
  assert.ok(receipt?.eligible);
  return receipt;
}

test('a current exact F290 Collective result counts as the owner decision awaiting attention', () => {
  const result = project(collectiveResultOwnerRead());

  assert.equal(result.status, 'available');
  assert.equal(result.totalCount, 1);
  assert.equal(result.attentionCount, 1);
  assert.equal(result.items[0]?.decisionRef, `f290.collective_work_result:${producerSubjectRef}`);
  assert.equal(result.items[0]?.kind, 'judgment');
});

test('F290 result qualification keeps exact counts at zero for consistent lookalikes and malformed actions', () => {
  const cases: [string, EntrustedWorkOwnerReadV1][] = [
    [
      'producer',
      mutateOwnerRead((ownerRead) => {
        resultReceipt(ownerRead).producer.producerId = 'f309.content_review';
      }),
    ],
    [
      'owner',
      mutateOwnerRead((ownerRead) => {
        resultReceipt(ownerRead).producer.ownerRef = 'collective-result:con_bbbbbbbb:work_aaaaaaaa';
      }),
    ],
    [
      'reason',
      mutateOwnerRead((ownerRead) => {
        resultReceipt(ownerRead).reasonCode = 'another_judgment';
      }),
    ],
    [
      'action',
      mutateOwnerRead((ownerRead) => {
        resultReceipt(ownerRead).action.actionRef =
          '/collective?connectionId=con_aaaaaaaa&workId=work_bbbbbbbb&workRevision=4&channelId=general&resultEventId=evt_result0000&resultRevision=2';
      }),
    ],
  ];

  for (const [label, ownerRead] of cases) {
    const result = project(ownerRead, {
      mode: 'visible',
      snapshot: { ownerUserId, revision: 1, entries: [] },
      state: source('owner_personal_ignored_items'),
    });
    assert.equal(result.attentionCount, 0, `${label} mismatch must not count as an exact F290 result decision`);
    assert.deepEqual(result.personalView?.groupCounts?.visible, { decisions: 0, userMentions: 0, other: 1 });
  }
});

test('an internally inconsistent producer revision withholds counts instead of certifying zero', () => {
  const result = project(
    mutateOwnerRead((ownerRead) => {
      resultReceipt(ownerRead).action.expectedProducerRevision = 3;
    }),
  );

  assert.equal(result.attentionCount, undefined);
  assert.deepEqual(result.consistency.reasons, ['producer_receipt_unverified']);
});

test('completed, stale, and personally ignored F290 results stay out of visible attention', () => {
  const completed = project(
    mutateOwnerRead((ownerRead) => {
      ownerRead.brief.current.state = 'done';
    }),
  );
  assert.equal(completed.attentionCount, 0);

  const stale = project(
    mutateOwnerRead((ownerRead) => {
      ownerRead.envelope.freshness = { state: 'stale', observedRevision: 7 };
    }),
  );
  assert.equal(stale.attentionCount, 0);

  const initial = project(collectiveResultOwnerRead());
  const coordinate = initial.items[0]?.preferenceCoordinate;
  assert.ok(coordinate);
  const snapshot: IgnoredItemSnapshot = {
    ownerUserId,
    revision: 2,
    entries: [{ coordinate, ignoredAt: 10 }],
  };
  const personalState = source('owner_personal_ignored_items');
  const visible = project(collectiveResultOwnerRead(), { mode: 'visible', snapshot, state: personalState });
  assert.equal(visible.totalCount, 0);
  assert.equal(visible.attentionCount, 0);
  assert.equal(visible.personalView?.originalAttentionCount, 1);
  assert.equal(visible.personalView?.visibleAttentionCount, 0);
  assert.equal(visible.personalView?.ignoredAttentionCount, 1);
});
