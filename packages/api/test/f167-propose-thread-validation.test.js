/**
 * F167 R4 — subjectTaskId server-side validation in POST /api/callbacks/propose-thread.
 *
 * Tests the three authorization branches added in R3:
 *   1. No taskLookup dep → 400 when subjectTaskId is passed
 *   2. Task not found → 400
 *   3. Task belongs to different user → 403
 *   4. Valid task → subjectTaskId + subjectTaskTitle flow to created proposal
 *   5. No subjectTaskId → legacy path (no validation)
 *   6–8. Card shows task binding when subjectTaskId present / absent / title-less
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

const { registerCallbackProposeThreadRoutes } = await import('../dist/routes/callback-propose-thread-routes.js');
const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
const { buildProposalCardBlock } = await import('../dist/routes/proposal-card-block.js');

const TASK_A = {
  id: 'task-validate-a',
  title: 'Implement feature X',
  status: 'doing',
  ownerCatId: 'opus',
  threadId: 'thread-owner',
  userId: 'user-1',
  kind: 'work',
  subjectKey: null,
  why: 'test',
  createdBy: 'opus',
  createdAt: 1000,
  updatedAt: 1000,
};

/** R5/R6: Task with entrustedWork.developmentScope for scope persistence tests. */
const TASK_WITH_SCOPE = {
  ...TASK_A,
  id: 'task-validate-scope',
  entrustedWork: {
    developmentScope: {
      featureRef: 'feature:F322',
      phaseKey: 'B',
      workUnitRef: 'feature-phase:F322:B',
      acceptedSourceRef: 'file:docs/features/F322.md',
      acceptedRevision: 'c'.repeat(40),
    },
  },
};

describe('F167 R4 — propose-thread subjectTaskId validation', () => {
  let registry;
  let proposalStore;
  let threadStore;
  let messageStore;
  let socketManager;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    registry = new InvocationRegistry();
    proposalStore = new InMemoryProposalStore();
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    };
  });

  // Minimal mock: publish() returns a fake envelope without touching the real
  // approval pipeline (commitEnvelope runs assertApprovalEnvelopeIdentity which
  // requires a registered producer — not what we're testing here).
  const mockApprovalIngress = {
    async publish(draft) {
      const messageId = `card-msg-${draft.canonicalProposalId}`;
      return { approvalCardRef: { messageId, threadId: draft.cardThreadId } };
    },
  };

  function createApp({ taskLookup } = {}) {
    const app = Fastify();
    registerCallbackAuthHook(app, registry);
    registerCallbackProposeThreadRoutes(app, {
      registry,
      proposalStore,
      threadStore,
      messageStore,
      socketManager,
      approvalIngress: mockApprovalIngress,
      ...(taskLookup ? { taskLookup } : {}),
    });
    return app;
  }

  async function setupAuth(userId = 'user-1') {
    const thread = threadStore.create(userId, 'Source');
    // positional: userId, catId, threadId, parentInvocationId, a2aTriggerMessageId,
    // toolExecutionPolicy, originTriggerMessageId
    const { invocationId, callbackToken } = await registry.create(
      userId,
      'opus',
      thread.id,
      undefined,
      undefined,
      undefined,
      'msg-origin',
    );
    return { invocationId, callbackToken };
  }

  async function injectProposal(app, auth, subjectTaskId) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-thread',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        title: 'Test child thread',
        reason: 'Testing subjectTaskId validation',
        ...(subjectTaskId !== undefined ? { subjectTaskId } : {}),
      },
    });
  }

  test('subjectTaskId without taskLookup dep → 400', async () => {
    const app = createApp({ taskLookup: undefined });
    const auth = await setupAuth();
    const res = await injectProposal(app, auth, 'task-xyz');
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('not supported'), 'error must mention task store not available');
  });

  test('subjectTaskId referencing non-existent task → 400', async () => {
    const taskLookup = {
      async get() {
        return null;
      },
    };
    const app = createApp({ taskLookup });
    const auth = await setupAuth();
    const res = await injectProposal(app, auth, 'task-nonexistent');
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('non-existent'), 'error must mention task not found');
  });

  test('subjectTaskId belonging to different user → 403', async () => {
    const otherUserTask = { ...TASK_A, userId: 'user-other' };
    const taskLookup = {
      async get(id) {
        return id === TASK_A.id ? otherUserTask : null;
      },
    };
    const app = createApp({ taskLookup });
    const auth = await setupAuth();
    const res = await injectProposal(app, auth, TASK_A.id);
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('different user'), 'error must mention ownership mismatch');
  });

  test('valid subjectTaskId → proposal persists subjectTaskId + subjectTaskTitle', async () => {
    const taskLookup = {
      async get(id) {
        return id === TASK_A.id ? TASK_A : null;
      },
    };
    const app = createApp({ taskLookup });
    const auth = await setupAuth();
    const res = await injectProposal(app, auth, TASK_A.id);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.proposalId, 'response must include proposalId');

    const proposal = proposalStore.get(body.proposalId);
    assert.equal(proposal.subjectTaskId, TASK_A.id, 'subjectTaskId must be persisted');
    assert.equal(proposal.subjectTaskTitle, TASK_A.title, 'subjectTaskTitle must be derived from task');
  });

  test('no subjectTaskId → proposal created without task binding', async () => {
    const taskLookup = {
      async get() {
        return TASK_A;
      },
    };
    const app = createApp({ taskLookup });
    const auth = await setupAuth();
    const res = await injectProposal(app, auth, undefined);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const proposal = proposalStore.get(body.proposalId);
    assert.equal(proposal.subjectTaskId, undefined, 'no subjectTaskId on legacy proposal');
    assert.equal(proposal.subjectTaskTitle, undefined, 'no subjectTaskTitle on legacy proposal');
  });

  test('R6: task with entrustedWork.developmentScope → proposal persists approvedDevelopmentScope', async () => {
    const taskLookup = {
      async get(id) {
        return id === TASK_WITH_SCOPE.id ? TASK_WITH_SCOPE : null;
      },
    };
    const app = createApp({ taskLookup });
    const auth = await setupAuth();
    const res = await injectProposal(app, auth, TASK_WITH_SCOPE.id);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const proposal = proposalStore.get(body.proposalId);
    assert.ok(proposal.approvedDevelopmentScope, 'scope must be persisted on proposal');
    assert.equal(proposal.approvedDevelopmentScope.featureRef, 'feature:F322');
    assert.equal(proposal.approvedDevelopmentScope.workUnitRef, 'feature-phase:F322:B');
    assert.equal(proposal.approvedDevelopmentScope.acceptedRevision, 'c'.repeat(40));
  });

  test('R6: task without entrustedWork → proposal has no approvedDevelopmentScope', async () => {
    const taskLookup = {
      async get(id) {
        return id === TASK_A.id ? TASK_A : null;
      },
    };
    const app = createApp({ taskLookup });
    const auth = await setupAuth();
    const res = await injectProposal(app, auth, TASK_A.id);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const proposal = proposalStore.get(body.proposalId);
    assert.equal(proposal.approvedDevelopmentScope, undefined, 'no scope without entrustedWork');
  });
});

describe('F167 R4 — proposal card task binding visibility', () => {
  test('card includes 关联任务 field with title + ID', () => {
    const card = buildProposalCardBlock({
      proposalId: 'prop-card-1',
      status: 'pending',
      sourceThreadId: 'th',
      sourceInvocationId: 'inv',
      sourceCatId: 'opus',
      title: 'Card test',
      reason: 'test',
      parentThreadId: 'th',
      preferredCats: [],
      projectPath: '/test',
      createdBy: 'user-1',
      createdAt: 1000,
      subjectTaskId: 'task-abc',
      subjectTaskTitle: 'Build feature Z',
    });
    const field = card.fields.find((f) => f.label === '关联任务');
    assert.ok(field, 'card must include 关联任务 field');
    assert.ok(field.value.includes('Build feature Z'), 'card must show task title');
    assert.ok(field.value.includes('task-abc'), 'card must show task ID');
  });

  test('card omits 关联任务 field when no subjectTaskId', () => {
    const card = buildProposalCardBlock({
      proposalId: 'prop-card-2',
      status: 'pending',
      sourceThreadId: 'th',
      sourceInvocationId: 'inv',
      sourceCatId: 'opus',
      title: 'Legacy',
      reason: 'test',
      parentThreadId: 'th',
      preferredCats: [],
      projectPath: '/test',
      createdBy: 'user-1',
      createdAt: 2000,
    });
    assert.equal(
      card.fields.find((f) => f.label === '关联任务'),
      undefined,
    );
  });

  test('card shows raw task ID when subjectTaskTitle absent', () => {
    const card = buildProposalCardBlock({
      proposalId: 'prop-card-3',
      status: 'pending',
      sourceThreadId: 'th',
      sourceInvocationId: 'inv',
      sourceCatId: 'opus',
      title: 'ID-only',
      reason: 'test',
      parentThreadId: 'th',
      preferredCats: [],
      projectPath: '/test',
      createdBy: 'user-1',
      createdAt: 3000,
      subjectTaskId: 'task-legacy-123',
    });
    const field = card.fields.find((f) => f.label === '关联任务');
    assert.ok(field, 'card must include 关联任务 field');
    assert.equal(field.value, 'task-legacy-123', 'should show raw task ID');
  });
});
