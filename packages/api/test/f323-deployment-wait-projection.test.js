import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { buildDeploymentWaitProjection } from '../dist/domains/runtime-deployment/DeploymentWaitProjection.js';
import { registerDeploymentWaitProjectionRoutes } from '../dist/routes/deployment-wait-projection-routes.js';

const TARGET = 'a'.repeat(40);
const RUNNING = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const SUBJECT = 'deployment:installation-1:runtime';

function activeWait({ id, threadId, kind = 'revision_included', createdAt = 1_000, ownerCatId = 'codex-sol' }) {
  const when =
    kind === 'revision_included' ? { kind, revision: TARGET, services: ['api', 'web'] } : { kind, services: ['api'] };
  return {
    id,
    kind: 'work',
    threadId,
    subjectKey: null,
    title: `Task ${id}`,
    ownerCatId,
    status: 'blocked',
    why: 'Wait for the daily runtime.',
    createdBy: ownerCatId,
    createdAt: createdAt - 100,
    updatedAt: createdAt,
    userId: 'user-a',
    sourceMessageId: `message-${id}`,
    deploymentWait: {
      await: {
        v: 1,
        generation: 1,
        subjectRef: SUBJECT,
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { bootId: 'boot-1', bootSequence: 1, capturedAt: 900 },
        // biome-ignore lint/suspicious/noThenProperty: F280 frozen continuation field.
        continuation: { when: [when], then: `Continue ${id}` },
        autoRenew: false,
        createdAt,
      },
    },
  };
}

function readyWait({ id, threadId, ownerCatId = 'kimi' }) {
  return {
    ...activeWait({ id, threadId, ownerCatId }),
    deploymentWait: {
      waitOutcome: {
        v: 1,
        domain: 'deployment',
        outcomeId: `outcome-${id}`,
        generation: 1,
        subjectRef: SUBJECT,
        ownerFence: { kind: 'containing_task', generation: 1 },
        reason: 'matched',
        at: 3_000,
        registeredAt: 1_000,
        delivery: 'delivered',
        nextStep: `Continue ${id}`,
        deploymentMatch: {
          kind: 'revision_included',
          services: ['api', 'web'],
          targetRevision: TARGET,
          bootId: 'boot-2',
          bootSequence: 2,
          runningRevision: CANDIDATE,
          observedAt: 2_900,
          proofKind: 'git_ancestry',
        },
      },
    },
  };
}

function currentObservation({ included = false } = {}) {
  return {
    subjectRef: SUBJECT,
    bootId: 'boot-1',
    bootSequence: 1,
    runningRevision: RUNNING,
    readyServices: ['api', 'web'],
    observedAt: 4_000,
    inclusionProof: {
      kind: 'git_ancestry',
      targetRevision: TARGET,
      runningRevision: RUNNING,
      included,
    },
  };
}

describe('F323 deployment wait Hub projection', () => {
  it('keeps wait items independent, separates ready-to-return, and proves the candidate K count', async () => {
    const pending = readyWait({ id: 'wait-ready', threadId: 'thread-b' });
    pending.deploymentWait.waitOutcome.delivery = 'pending';
    const tasks = [
      activeWait({ id: 'wait-a', threadId: 'thread-a' }),
      activeWait({ id: 'wait-b', threadId: 'thread-a', kind: 'new_ready_boot', createdAt: 1_100 }),
      pending,
    ];
    const projection = await buildDeploymentWaitProjection({
      projectPath: '/project/cafe',
      tasks,
      threadTitles: new Map([
        ['thread-a', 'Runtime work'],
        ['thread-b', 'Acceptance work'],
      ]),
      observeDeployment: async () => currentObservation({ included: true }),
      candidate: {
        revision: CANDIDATE,
        observedAt: 5_000,
        proveInclusion: async (targetRevision) => ({
          kind: 'git_ancestry',
          targetRevision,
          runningRevision: CANDIDATE,
          included: true,
        }),
      },
    });

    assert.equal(projection.items.length, 3, 'task identity, not cat or thread, owns each wait row');
    assert.deepEqual(
      projection.items.map(({ taskId, state }) => [taskId, state]).sort(([left], [right]) => left.localeCompare(right)),
      [
        ['wait-a', 'unknown'],
        ['wait-b', 'waiting_for_update'],
        ['wait-ready', 'ready_to_return'],
      ],
    );
    assert.equal(projection.items[0].threadTitle, 'Runtime work');
    assert.equal(projection.items[0].sourceMessageId, 'message-wait-a');
    assert.equal(projection.items[0].nextStep, 'Continue wait-a');
    assert.deepEqual(projection.candidate, {
      revision: CANDIDATE,
      observedAt: 5_000,
      satisfiableCount: 2,
      unknownCount: 0,
    });
  });

  it('keeps unavailable evidence visible as unknown and never promotes it into the candidate count', async () => {
    const projection = await buildDeploymentWaitProjection({
      projectPath: '/project/cafe',
      tasks: [activeWait({ id: 'wait-unknown', threadId: 'thread-a' })],
      threadTitles: new Map([['thread-a', 'Unknown proof']]),
      observeDeployment: async () => null,
      candidate: {
        revision: CANDIDATE,
        observedAt: 5_000,
        proveInclusion: async () => null,
      },
    });

    assert.equal(projection.items[0].state, 'unknown');
    assert.equal(projection.items[0].stateReason, 'deployment_evidence_unavailable');
    assert.deepEqual(projection.candidate, {
      revision: CANDIDATE,
      observedAt: 5_000,
      satisfiableCount: 0,
      unknownCount: 1,
    });
  });

  it('shows readiness only after a persisted unmatched admission outcome and stops showing admitted work', async () => {
    const pending = readyWait({ id: 'pending', threadId: 'thread-a' });
    pending.deploymentWait.waitOutcome.delivery = 'pending';
    const projection = await buildDeploymentWaitProjection({
      projectPath: '/project/cafe',
      tasks: [
        activeWait({ id: 'active', threadId: 'thread-a' }),
        pending,
        readyWait({ id: 'admitted', threadId: 'thread-a' }),
      ],
      threadTitles: new Map([['thread-a', 'Runtime work']]),
      observeDeployment: async () => currentObservation({ included: true }),
    });
    assert.deepEqual(
      projection.items.map(({ taskId, state }) => [taskId, state]),
      [
        ['active', 'unknown'],
        ['pending', 'ready_to_return'],
      ],
    );
    assert.equal(projection.items[1].matchedAt, 3_000);
  });

  it('shares one running observation and candidate inclusion proof per target in a projection', async () => {
    let observed = 0;
    let proved = 0;
    const projection = await buildDeploymentWaitProjection({
      projectPath: '/project/cafe',
      tasks: [activeWait({ id: 'first', threadId: 'thread-a' }), activeWait({ id: 'second', threadId: 'thread-a' })],
      threadTitles: new Map([['thread-a', 'Runtime work']]),
      observeDeployment: async () => {
        observed += 1;
        return currentObservation();
      },
      candidate: {
        revision: CANDIDATE,
        observedAt: 5_000,
        proveInclusion: async (targetRevision) => {
          proved += 1;
          return { kind: 'git_ancestry', targetRevision, runningRevision: CANDIDATE, included: true };
        },
      },
    });
    assert.equal(projection.items.length, 2);
    assert.equal(observed, 1);
    assert.equal(proved, 1);
  });

  it('counts candidate readiness only for the candidate deployment subject', async () => {
    const foreign = activeWait({ id: 'foreign', threadId: 'thread-a' });
    foreign.deploymentWait.await.subjectRef = 'deployment:installation-1:alpha';
    const projection = await buildDeploymentWaitProjection({
      projectPath: '/project/cafe',
      tasks: [activeWait({ id: 'runtime', threadId: 'thread-a' }), foreign],
      threadTitles: new Map([['thread-a', 'Runtime work']]),
      observeDeployment: async () => currentObservation(),
      candidate: {
        revision: CANDIDATE,
        observedAt: 5_000,
        subjectRef: SUBJECT,
        proveInclusion: async (targetRevision) => ({
          kind: 'git_ancestry',
          targetRevision,
          runningRevision: CANDIDATE,
          included: true,
        }),
      },
    });
    assert.equal(projection.candidate.satisfiableCount, 1);
  });

  it('authenticates the project read and never leaks waits from another project', async () => {
    const app = Fastify();
    let observations = 0;
    let proofs = 0;
    const foreign = { ...activeWait({ id: 'wait-foreign', threadId: 'thread-a' }), userId: 'user-b' };
    const tasksByThread = new Map([
      ['thread-a', [activeWait({ id: 'wait-a', threadId: 'thread-a' }), foreign]],
      ['thread-other', [activeWait({ id: 'wait-other', threadId: 'thread-other' })]],
    ]);
    registerDeploymentWaitProjectionRoutes(app, {
      threadStore: {
        listByProject: async (userId, projectPath) =>
          userId === 'user-a' && projectPath === '/project/cafe'
            ? [{ id: 'thread-a', title: 'Visible wait', projectPath, createdBy: 'user-a' }]
            : [],
      },
      taskStore: {
        listByKind: async () => [...tasksByThread.values()].flat(),
      },
      observeDeployment: async () => {
        observations += 1;
        return currentObservation();
      },
      readCandidate: async () => ({ revision: RUNNING, observedAt: 4_000 }),
      proveCandidateInclusion: async (targetRevision, runningRevision) => {
        proofs += 1;
        return { kind: 'git_ancestry', targetRevision, runningRevision, included: true };
      },
    });
    await app.ready();

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/runtime-deployment/waits?projectPath=%2Fproject%2Fcafe',
    });
    assert.equal(unauthorized.statusCode, 401);

    const response = await app.inject({
      method: 'GET',
      url: '/api/runtime-deployment/waits?projectPath=%2Fproject%2Fcafe',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().items.map((item) => item.taskId),
      ['wait-a'],
    );
    assert.equal(response.json().items[0].threadTitle, 'Visible wait');
    assert.equal(observations, 1);
    assert.equal(proofs, 1, 'running and candidate proof share one (target, revision) result');
    const repeated = await app.inject({
      method: 'GET',
      url: '/api/runtime-deployment/waits?projectPath=%2Fproject%2Fcafe',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(observations, 2, 'running boot observation remains fresh each poll');
    assert.equal(proofs, 1, 'immutable inclusion proof survives repeat Workspace polls');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/runtime-deployment/waits?projectPath=%2Fproject%2Fother',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(missing.statusCode, 404);
    await app.close();
  });
});
