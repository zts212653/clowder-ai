import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { InvocationRecord } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { projectCompanionDecisions } from '../src/routes/companion-decision-projection.js';
import { registerCompanionWorkReadRoutes } from '../src/routes/companion-work-read.js';

function authenticated(app: ReturnType<typeof Fastify>) {
  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/callbacks/companion/') && request.headers['x-test-principal'] === 'owner')
      request.callbackAuth = { userId: 'owner', threadId: 'home', catId: 'codex' } as unknown as InvocationRecord;
  });
}

test('running work groups multiple activities, counts threads once, keeps foreign occupancy and strips control handles', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  authenticated(app);
  app.get('/api/executions/active', async (request) => {
    assert.equal(request.headers['x-cat-cafe-user'], 'owner');
    assert.equal((request.query as { projectPath: string }).projectPath, '/current/project');
    return {
      projectPath: '/current/project',
      executions: [
        {
          executionId: 'live-1',
          turnInvocationId: 'private-1',
          threadId: 'thread-a',
          threadTitle: '画图',
          catId: 'opus',
          kind: 'live_invocation',
          startedAt: 1,
          cancelability: { state: 'cancelable', target: { executionId: 'live-1' } },
        },
        {
          executionId: 'occupied:private',
          threadId: 'thread-a',
          threadTitle: '画图',
          catId: 'opus',
          kind: 'managed_command',
          activity: 'test',
          startedAt: 2,
          cancelability: { state: 'not_cancelable', reason: 'foreign_principal' },
        },
        {
          executionId: 'live-2',
          threadId: 'thread-a',
          threadTitle: '画图',
          catId: 'kimi',
          kind: 'live_invocation',
          startedAt: 3,
          cancelability: { state: 'not_cancelable', reason: 'control_plane_unavailable' },
        },
      ],
    };
  });
  registerCompanionWorkReadRoutes(app, '/current/project');
  assert.equal((await app.inject('/api/callbacks/companion/running-work')).statusCode, 401);
  const response = await app.inject({
    url: '/api/callbacks/companion/running-work',
    headers: { 'x-test-principal': 'owner', 'x-cat-cafe-user': 'other' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual([body.executionCount, body.workGroupCount, body.workingThreadCount], [3, 2, 1]);
  assert.equal(body.groups[0].activities.length, 2);
  assert.equal(body.groups[0].activities[1].occupancy, 'foreign');
  assert.doesNotMatch(response.body, /executionId|turnInvocationId|cancelability|private-1/);
});

test('unavailable running source has no zero counts', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  authenticated(app);
  app.get('/api/executions/active', async (_request, reply) => reply.code(503).send({ error: 'offline' }));
  registerCompanionWorkReadRoutes(app, '/current/project');
  const response = await app.inject({
    url: '/api/callbacks/companion/running-work',
    headers: { 'x-test-principal': 'owner' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'unavailable');
  assert.equal('executionCount' in response.json(), false);
});

test('decision read keeps all F246 pending and enriches only exact current F310 links', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  authenticated(app);
  app.get('/api/approval-hub/pending', async (request) => {
    assert.equal(request.headers['x-cat-cafe-user'], 'owner');
    return {
      coverage: { state: 'complete' },
      items: [
        {
          proposalId: 'taste-1',
          sourceFeatureId: 'F221',
          requesterCatId: 'opus',
          ownerUserId: 'owner',
          summary: '品味提案',
          detail: { quote: '留白' },
          navigation: {
            state: 'anchored',
            originRef: { kind: 'message', threadId: 'taste-origin', messageId: 'request-1' },
            approvalCardRef: { threadId: 'taste-origin', messageId: 'card-1' },
          },
          inlineApprovable: true,
          decisionMode: 'approve-reject',
          resolution: 'open',
          materialization: { state: 'not_started' },
          createdAt: 77,
          entrustedWorkTaskRef: { subjectRef: 'task:work:one', observedRevision: 3 },
        },
        {
          proposalId: 'thread-1',
          sourceFeatureId: 'F128',
          requesterCatId: 'opus',
          ownerUserId: 'owner',
          summary: '新线程',
          detail: {},
          navigation: {
            state: 'anchored',
            originRef: { kind: 'message', threadId: 'thread-origin', messageId: 'request-2' },
            approvalCardRef: { threadId: 'thread-origin', messageId: 'card-2' },
          },
          inlineApprovable: false,
          resolution: 'accepted',
          materialization: { state: 'outcome_unknown' },
          createdAt: 78,
        },
      ],
    };
  });
  app.get('/api/entrusted-work/needs-me', async () => ({
    coverage: { state: 'complete' },
    ownerReads: [
      {
        envelope: {
          subjectRef: 'task:work:one',
          revision: 3,
          freshness: { state: 'current', observedRevision: 3 },
          visibility: { ownerUserId: 'owner' },
        },
        brief: { outcome: { state: 'known', value: '看具体提案' }, current: { state: 'doing' } },
        attentionReceipts: [
          {
            eligible: true,
            kind: 'judgment',
            recommendation: 'Please decide',
            producer: { producerId: 'f246.approval', subjectRef: 'approval:F221:taste-1', revision: 77 },
            action: { actionRef: 'approval:F221:taste-1', expectedProducerRevision: 77 },
            taskRef: { subjectRef: 'task:work:one', observedRevision: 3 },
          },
          {
            eligible: true,
            kind: 'judgment',
            recommendation: 'Please decide',
            producer: { producerId: 'f306.runtime_interaction', subjectRef: 'interaction:one', revision: 8 },
            action: { actionRef: 'message:home:one', expectedProducerRevision: 8 },
            taskRef: { subjectRef: 'task:work:one', observedRevision: 3 },
          },
          {
            eligible: false,
            producer: { producerId: 'f310.expired', subjectRef: 'expired:one', revision: 7 },
            taskRef: { subjectRef: 'task:work:one', observedRevision: 3 },
          },
        ],
        preparedArtifact: {
          artifactRef: 'artifact:one',
          artifactRevision: 'v1',
          completenessRef: 'complete',
          previewRef: 'preview',
          openInWorkspaceRef: 'workspace',
        },
      },
      {
        envelope: {
          subjectRef: 'task:work:stale',
          revision: 4,
          freshness: { state: 'current', observedRevision: 4 },
          visibility: { ownerUserId: 'owner' },
        },
        brief: { current: { state: 'doing' } },
        preparedArtifact: {
          artifactRef: 'artifact:two',
          artifactRevision: 'v1',
          completenessRef: 'complete',
          previewRef: 'preview',
          openInWorkspaceRef: 'workspace',
        },
        attentionReceipts: [
          {
            eligible: true,
            kind: 'judgment',
            recommendation: 'Please decide',
            producer: { producerId: 'f309.content_review', subjectRef: 'followup:one', revision: 4 },
            action: { actionRef: 'content:one', expectedProducerRevision: 4 },
            taskRef: { subjectRef: 'task:work:stale', observedRevision: 4 },
          },
        ],
      },
    ],
  }));
  registerCompanionWorkReadRoutes(app, '/current/project');
  const response = await app.inject({
    url: '/api/callbacks/companion/decisions',
    headers: { 'x-test-principal': 'owner' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.approvalCount, 2);
  assert.equal(body.needsMeCount, 2);
  assert.equal(body.otherNeedsMeCount, 2);
  assert.equal(body.approvals[0].linkedNeedsMe.envelope.subjectRef, 'task:work:one');
  assert.equal(body.approvals[1].linkedNeedsMe, undefined);
  assert.deepEqual(
    body.approvals.map((item: { resolution: string }) => item.resolution),
    ['open', 'accepted'],
  );
  assert.equal(body.approvals[1].materialization.state, 'outcome_unknown');
  assert.equal(body.otherNeedsMe.length, 2);
  assert.equal(body.otherNeedsMe[0].envelope.subjectRef, 'task:work:one');
  assert.deepEqual(
    body.otherNeedsMe[0].attentionReceipts.map(
      (receipt: { producer: { producerId: string } }) => receipt.producer.producerId,
    ),
    ['f306.runtime_interaction'],
  );
});

test('decision projection refuses a cross-owner source even when its upstream endpoint returned 200', () => {
  assert.throws(
    () =>
      projectCompanionDecisions(
        {
          coverage: { state: 'complete' },
          items: [
            {
              proposalId: 'other-1',
              sourceFeatureId: 'F221',
              requesterCatId: 'opus',
              ownerUserId: 'other',
              summary: 'private',
              detail: {},
              navigation: { state: 'legacy_unanchored' },
              inlineApprovable: false,
              resolution: 'open',
              materialization: { state: 'not_started' },
              createdAt: 1,
            },
          ],
        },
        { ownerReads: [], coverage: { state: 'complete' } },
        'owner',
        { offset: 0, limit: 20 },
        2,
      ),
    /owner identity mismatch/i,
  );
});

test('unavailable decision source never reports zero pending items', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  authenticated(app);
  app.get('/api/approval-hub/pending', async (_request, reply) => reply.code(503).send({ error: 'offline' }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  registerCompanionWorkReadRoutes(app, '/current/project');
  const response = await app.inject({
    url: '/api/callbacks/companion/decisions',
    headers: { 'x-test-principal': 'owner' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'unavailable');
  assert.equal('approvalCount' in response.json(), false);
});
