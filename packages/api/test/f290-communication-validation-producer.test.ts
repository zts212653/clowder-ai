/**
 * F290 communication — the Needs Me producer for Collective results, against the shared assignment matcher.
 *
 * Fixtures are a transformed copy of f290-collective-work-result-producer.test.ts (same connector/Task/Artifact doubles).
 * The default fixture is a NATURALLY accepted, Host-admitted Work: assignment authored by the accepting Cat
 * (actor.kind = agent, accountable Human derived from its connection), a Service acceptance notice on the Host source, and
 * an agent `committed` history entry, mirroring the real Service projection exercised in f290-communication-validation-l2.
 * These are contract tests of the consumer predicate; the Artifact/Task/connector doubles are unchanged fixtures.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CollectiveConnector, CollectiveWorkResultPublication } from '@cat-cafe/collective-connector';
import { type CollectiveWorkProjection, createCatId, type TaskItem } from '@cat-cafe/shared';
import { F290CollectiveWorkResultProducerAdapter } from '../src/domains/growing/F290CollectiveWorkResultProducerAdapter.js';

const taskId = 'task-result';
const taskRef = `task:work:${taskId}`;
const sourceMessageId = 'source-message';

function task(): TaskItem {
  return {
    id: taskId,
    threadId: 'thread-private',
    title: 'Prepare the Collective result',
    why: 'Owner admitted Work',
    status: 'doing',
    createdBy: 'user',
    ownerCatId: createCatId('codex-sol'),
    userId: 'owner',
    kind: 'work',
    subjectKey: null,
    createdAt: 1,
    updatedAt: 2,
    entrustedWork: {
      revision: 3,
      admission: {
        basis: 'authorized_source',
        sourceRefs: [`message:${sourceMessageId}`],
        idempotencyKey: 'collective-result',
        receiptRef: 'task:receipt:collective-result',
        admittedAt: 1,
        authorityRef: 'message:owner-admission',
      },
      intendedOutcome: 'A reviewable result is ready',
      time: {},
      artifactRefs: ['artifact:result'],
      closure: {
        condition: 'The Collective result is accepted',
        expectedSignal: 'collective:accepted-result',
        state: 'open',
        evidenceRefs: [],
      },
    },
  };
}

function work(): CollectiveWorkProjection {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_source0000',
    sourceLocation: { channelId: 'general' },
    title: 'Prepared Collective result',
    intendedOutcome: 'A reviewable result is ready',
    proposedBy: {
      kind: 'agent',
      humanId: 'human_aaaaaaaa',
      humanDisplayName: 'Owner',
      connectionId: 'con_aaaaaaaa',
      catId: 'codex-sol',
      displayName: 'Sol',
    },
    acceptance: {
      v: 1,
      workId: 'work_aaaaaaaa',
      sourceEventId: 'evt_source0000',
      operationRef: 'cat-accept:aaaa',
      grantRef: 'grant-guides',
      grantRevision: 1,
      requestKind: 'guide',
      hostAdmission: {
        issuer: 'host',
        state: 'admitted',
        receiptRef: 'host-admission:aaaa',
        at: '2026-09-19T12:00:30.000Z',
      },
    },
    accountableHumanId: 'human_aaaaaaaa',
    assignment: {
      humanId: 'human_aaaaaaaa',
      connectionId: 'con_aaaaaaaa',
      catId: 'codex-sol',
      displayName: 'Sol',
      participationRevision: 1,
      assignedAt: '2026-09-19T12:00:00.000Z',
    },
    assignmentEventId: 'evt_assignment0',
    dependencyWorkIds: [],
    lifecycle: 'result_ready',
    status: 'result_ready',
    resultEventId: 'evt_result0000',
    resultRevision: 2,
    revision: 4,
    createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:01:00.000Z',
    history: [
      {
        revision: 2,
        action: 'committed',
        actor: {
          kind: 'agent',
          humanId: 'human_aaaaaaaa',
          humanDisplayName: 'Owner',
          connectionId: 'con_aaaaaaaa',
          catId: 'codex-sol',
          displayName: 'Sol',
        },
        at: '2026-09-19T12:00:10.000Z',
        eventId: 'evt_assignment0',
      },
    ],
  };
}

function publication(): CollectiveWorkResultPublication {
  return {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    authorizedHumanId: 'human_aaaaaaaa',
    localOwnerUserId: 'owner',
    assignmentEventId: 'evt_assignment0',
    channelId: 'general',
    catId: 'codex-sol',
    taskRef,
    taskRevision: 3,
    workId: 'work_aaaaaaaa',
    resultEventId: 'evt_result0000',
    resultRevision: 2,
    artifactSnapshot: {
      taskRef,
      taskRevision: 3,
      artifactRef: 'artifact:result',
      artifactRevision: '7',
      completenessRef: 'artifact:result#complete:7',
      previewRef: 'artifact:result#preview:7',
      openInWorkspaceRef: 'workspace:artifact:thread-private:7:artifact:result',
    },
  };
}

function sourceMessage() {
  return {
    id: sourceMessageId,
    threadId: 'thread-public-source',
    userId: 'owner',
    catId: null,
    content: 'Prepare the Collective result',
    timestamp: 1,
    source: {
      connector: 'collective',
      label: 'Collective',
      meta: {
        participation: {
          serviceInstanceId: 'svc_aaaaaaaa',
          collectiveId: 'col_aaaaaaaa',
          connectionId: 'con_aaaaaaaa',
          eventId: 'evt_assignment0',
          location: { channelId: 'general' },
          catId: 'codex-sol',
          participationRevision: 1,
          actor: {
            kind: 'agent',
            human: { humanId: 'human_aaaaaaaa', displayName: 'Owner' },
            agent: { agentId: 'codex-sol', displayName: 'Sol' },
            provenance: {
              connectionId: 'con_aaaaaaaa',
              endpointId: 'ep_aaaaaaaa',
              endpointLabel: 'You Café',
              catId: 'codex-sol',
              sessionRef: 'invocation:accepting-turn',
            },
          },
        },
        workAcceptanceNotice: {
          v: 1,
          workId: 'work_aaaaaaaa',
          sourceEventId: 'evt_source0000',
          operationRef: 'cat-accept:aaaa',
          grantRef: 'grant-guides',
          grantRevision: 1,
          requestKind: 'guide',
        },
      },
    },
  };
}

function fixture() {
  let currentTask = task();
  let currentWork = work();
  let currentPublication = publication();
  let currentSource = sourceMessage();
  let currentArtifact = { ...currentPublication.artifactSnapshot };
  const connector = {
    async listWorkResultPublicationCandidates() {
      return [
        {
          connectionId: currentPublication.connectionId,
          workId: currentPublication.workId,
          taskRef: currentPublication.taskRef,
        },
      ];
    },
    async withAssignedWorkAuthority(connectionId: string, workId: string, consume: (scope: unknown) => unknown) {
      assert.equal(connectionId, currentPublication.connectionId);
      assert.equal(workId, currentPublication.workId);
      return consume({
        connection: {
          serviceInstanceId: currentPublication.serviceInstanceId,
          collectiveId: currentPublication.collectiveId,
          connectionId,
          authorizedHumanId: currentPublication.authorizedHumanId,
          authorityStatus: 'connected',
        },
        hostRoute: { localOwnerUserId: currentPublication.localOwnerUserId },
        inbox: [],
        work: structuredClone(currentWork),
        resultPublications: [
          structuredClone({ ...currentPublication, resultEventId: 'evt_result_old', resultRevision: 1 }),
          structuredClone(currentPublication),
        ],
      });
    },
  } as unknown as CollectiveConnector;
  const adapter = new F290CollectiveWorkResultProducerAdapter({
    connector: () => connector,
    tasks: {
      async get(id) {
        return id === taskId ? structuredClone(currentTask) : null;
      },
    },
    messages: {
      async getById(id) {
        return id === sourceMessageId ? (structuredClone(currentSource) as never) : null;
      },
    },
    artifacts: {
      async readPreparedArtifact() {
        if (!currentArtifact) return null;
        const { taskRef: _taskRef, taskRevision: _taskRevision, ...artifact } = currentArtifact;
        return structuredClone(artifact) as never;
      },
    },
  });
  return {
    adapter,
    mutateTask(mutator: (value: TaskItem) => TaskItem) {
      currentTask = mutator(currentTask);
    },
    mutateWork(mutator: (value: CollectiveWorkProjection) => CollectiveWorkProjection) {
      currentWork = mutator(currentWork);
    },
    mutatePublication(mutator: (value: CollectiveWorkResultPublication) => CollectiveWorkResultPublication) {
      currentPublication = mutator(currentPublication);
    },
    mutateSource(mutator: (value: ReturnType<typeof sourceMessage>) => ReturnType<typeof sourceMessage>) {
      currentSource = mutator(currentSource);
    },
    mutateArtifact(mutator: (value: typeof currentArtifact) => typeof currentArtifact) {
      currentArtifact = mutator(currentArtifact);
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

/** A legacy Human commit: Human-authored assignment source, no Cat acceptance. */
function asLegacyHumanCommit(f: Fixture) {
  f.mutateWork((value) => ({
    ...value,
    proposedBy: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
    acceptance: undefined,
    history: [],
  }));
  f.mutateSource((value) => ({
    ...value,
    source: {
      ...value.source,
      meta: {
        ...value.source.meta,
        workAcceptanceNotice: undefined as never,
        participation: {
          ...value.source.meta.participation,
          actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' } as never,
        },
      },
    },
  }));
}

describe('F290 Collective result producer with the shared assignment matcher', () => {
  test('a naturally accepted, Host-admitted Work with a current result projects a Needs Me receipt', async () => {
    const f = fixture();
    const receipts = await f.adapter.listCurrentReceipts('owner');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.eligible, true);
  });

  test('legacy control: an actual Human commit (Human source, no Cat acceptance) still projects a receipt', async () => {
    const f = fixture();
    asLegacyHumanCommit(f);
    assert.equal((await f.adapter.listCurrentReceipts('owner')).length, 1);
  });

  test('a Human-authored source must NOT vouch for a Work that carries a Cat acceptance (they contradict)', async () => {
    const f = fixture();
    f.mutateSource((value) => ({
      ...value,
      source: {
        ...value.source,
        meta: {
          ...value.source.meta,
          participation: {
            ...value.source.meta.participation,
            actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' } as never,
          },
        },
      },
    }));
    assert.deepEqual(await f.adapter.listCurrentReceipts('owner'), []);
  });

  test('forged agent sources are refused: no/foreign acceptance, tampered or missing Host notice, other connection, no agent commit', async () => {
    const mutations: Array<[string, (f: Fixture) => void]> = [
      ['acceptance stripped', (f) => f.mutateWork((value) => ({ ...value, acceptance: undefined }))],
      [
        'acceptance names another source event',
        (f) =>
          f.mutateWork((value) => ({
            ...value,
            acceptance: value.acceptance && { ...value.acceptance, sourceEventId: 'evt_forged00000' },
          })),
      ],
      [
        'acceptance operation differs from the Host notice',
        (f) =>
          f.mutateWork((value) => ({
            ...value,
            acceptance: value.acceptance && { ...value.acceptance, operationRef: 'cat-accept:forged' },
          })),
      ],
      [
        'Host notice names another Work',
        (f) =>
          f.mutateSource((value) => ({
            ...value,
            source: {
              ...value.source,
              meta: {
                ...value.source.meta,
                workAcceptanceNotice: { ...value.source.meta.workAcceptanceNotice, workId: 'work_forged0000' },
              },
            },
          })),
      ],
      [
        'Host notice missing',
        (f) =>
          f.mutateSource((value) => ({
            ...value,
            source: { ...value.source, meta: { ...value.source.meta, workAcceptanceNotice: undefined as never } },
          })),
      ],
      [
        'source claims another connection',
        (f) =>
          f.mutateSource((value) => ({
            ...value,
            source: {
              ...value.source,
              meta: {
                ...value.source.meta,
                participation: {
                  ...value.source.meta.participation,
                  actor: {
                    ...value.source.meta.participation.actor,
                    provenance: { ...value.source.meta.participation.actor.provenance, connectionId: 'con_bbbbbbbb' },
                  },
                },
              },
            },
          })),
      ],
      ['no agent `committed` history for this assignment', (f) => f.mutateWork((value) => ({ ...value, history: [] }))],
    ];
    for (const [label, mutate] of mutations) {
      const f = fixture();
      mutate(f);
      assert.deepEqual(await f.adapter.listCurrentReceipts('owner'), [], label);
    }
  });
});
