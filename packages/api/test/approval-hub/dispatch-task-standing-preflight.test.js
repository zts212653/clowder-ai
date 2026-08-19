import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

const TASK_ACTION = {
  subjectRef: 'subject:task:task-standing-1',
  actionFamily: 'implement',
  successorSlot: 'implementer',
  mode: 'single',
  terminalPredicate: { kind: 'task_done' },
};

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
  };
}

function createMockInvocationRecordStore() {
  return {
    create() {
      return { outcome: 'created', invocationId: 'inv-0' };
    },
    update() {},
    get() {
      return null;
    },
  };
}

function createMockRouter() {
  return {
    async *routeExecution() {
      yield* [];
    },
    getExecutions() {
      return [];
    },
  };
}

async function createHarness(taskSnapshotFactory, options = {}) {
  const [
    { InvocationRegistry },
    { MessageStore },
    { ThreadStore },
    { InMemoryDispatchProposalStore },
    { ActionSuccessorAdmissionService },
    { ActionSubjectTruthResolver },
    { callbacksRoutes },
  ] = await Promise.all([
    import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
    import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'),
    import('../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'),
    import('../../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'),
    import('../../dist/domains/ball-custody/ActionSubjectTruthResolver.js'),
    import('../../dist/routes/callbacks.js'),
  ]);

  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const source = await threadStore.create('user-1', 'Source');
  const target = await threadStore.create('user-1', 'Target');
  await threadStore.addParticipants(source.id, ['opus']);
  await threadStore.addParticipants(target.id, ['sonnet']);
  const taskSnapshot = taskSnapshotFactory({ source, target });

  const store = new InMemoryDispatchProposalStore();
  const originalCreate = store.create.bind(store);
  let createCalls = 0;
  store.create = async (input) => {
    createCalls += 1;
    return originalCreate(input);
  };
  const ingressPublishCalls = [];
  const truthResolver = new ActionSubjectTruthResolver(
    {},
    {
      async get() {
        return null;
      },
    },
    undefined,
    {
      async get(taskId) {
        return taskId === taskSnapshot.id ? taskSnapshot : null;
      },
    },
  );
  const admissionService = new ActionSuccessorAdmissionService({}, truthResolver);

  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    socketManager: createMockSocketManager(),
    router: createMockRouter(),
    invocationRecordStore: createMockInvocationRecordStore(),
    dispatchProposalStore: store,
    ...(options.withoutAdmissionService ? {} : { actionSuccessorAdmissionService: admissionService }),
    approvalIngress: {
      async publish(draft) {
        ingressPublishCalls.push(draft);
      },
    },
  });
  await app.ready();
  const auth = await registry.create('user-1', 'opus', source.id);

  return {
    app,
    auth,
    source,
    target,
    store,
    ingressPublishCalls,
    getCreateCalls: () => createCalls,
  };
}

async function postTaskProposal(harness, clientMessageId) {
  return harness.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': harness.auth.invocationId,
      'x-callback-token': harness.auth.callbackToken,
    },
    payload: {
      threadId: harness.target.id,
      content: '@sonnet\nPlease implement the task.',
      targetCats: ['sonnet'],
      effectClass: 'assign_work',
      proposedAction: TASK_ACTION,
      clientMessageId,
    },
  });
}

describe('F246 task standing preflight', () => {
  for (const scenario of [
    {
      name: 'task thread does not match the proposal target thread',
      taskSnapshotFactory: ({ source }) => ({
        id: 'task-standing-1',
        status: 'doing',
        ownerCatId: 'sonnet',
        threadId: source.id,
        userId: 'user-1',
        updatedAt: 1,
      }),
      mismatchDimension: 'target_thread',
    },
    {
      name: 'task owner does not match the proposed holder',
      taskSnapshotFactory: ({ target }) => ({
        id: 'task-standing-1',
        status: 'doing',
        ownerCatId: 'codex-sol',
        threadId: target.id,
        userId: 'user-1',
        updatedAt: 1,
      }),
      mismatchDimension: 'owner',
    },
    {
      name: 'task tenant does not match the proposal owner',
      taskSnapshotFactory: ({ target }) => ({
        id: 'task-standing-1',
        status: 'doing',
        ownerCatId: 'sonnet',
        threadId: target.id,
        userId: 'another-user',
        updatedAt: 1,
      }),
      mismatchDimension: 'tenant',
    },
  ]) {
    test(`${scenario.name} fails before proposal/card/lineage persistence`, async (t) => {
      const harness = await createHarness(scenario.taskSnapshotFactory);
      t.after(() => harness.app.close());

      const response = await postTaskProposal(harness, `mismatch-${scenario.mismatchDimension}`);

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().kind, 'proposed_action_standing_mismatch');
      assert.deepEqual(response.json().mismatchDimensions, [scenario.mismatchDimension]);
      assert.equal(harness.getCreateCalls(), 0);
      assert.equal(harness.ingressPublishCalls.length, 0);
      assert.deepEqual(await harness.store.listPendingByUser('user-1'), []);
    });
  }

  test('matching durable task standing creates and publishes one proposal', async (t) => {
    const harness = await createHarness(({ target }) => ({
      id: 'task-standing-1',
      status: 'doing',
      ownerCatId: 'sonnet',
      threadId: target.id,
      userId: 'user-1',
      updatedAt: 1,
    }));
    t.after(() => harness.app.close());
    const response = await postTaskProposal(harness, 'matching-standing');

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'proposal_created');
    assert.equal(harness.getCreateCalls(), 1);
    assert.equal(harness.ingressPublishCalls.length, 1);
    assert.equal((await harness.store.listPendingByUser('user-1')).length, 1);
  });

  test('a completed durable task fails closed without creating a stale approval card', async (t) => {
    const harness = await createHarness(({ target }) => ({
      id: 'task-standing-1',
      status: 'done',
      ownerCatId: 'sonnet',
      threadId: target.id,
      userId: 'user-1',
      updatedAt: 2,
    }));
    t.after(() => harness.app.close());

    const response = await postTaskProposal(harness, 'completed-task');

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().kind, 'proposed_action_standing_mismatch');
    assert.match(response.json().message, /task is already done/);
    assert.equal(harness.getCreateCalls(), 0);
    assert.equal(harness.ingressPublishCalls.length, 0);
  });

  test('missing task-standing resolver fails closed before persistence', async (t) => {
    const harness = await createHarness(
      ({ target }) => ({
        id: 'task-standing-1',
        status: 'doing',
        ownerCatId: 'sonnet',
        threadId: target.id,
        userId: 'user-1',
        updatedAt: 1,
      }),
      { withoutAdmissionService: true },
    );
    t.after(() => harness.app.close());

    const response = await postTaskProposal(harness, 'missing-standing-resolver');

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().kind, 'proposed_action_standing_unavailable');
    assert.equal(harness.getCreateCalls(), 0);
    assert.equal(harness.ingressPublishCalls.length, 0);
  });
});
