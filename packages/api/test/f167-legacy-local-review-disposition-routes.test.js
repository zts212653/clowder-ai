import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('#1371 legacy local-review disposition routes', () => {
  let app;
  const inspections = [];
  const settlements = [];

  before(async () => {
    const { messageActionsRoutes } = await import('../dist/routes/message-actions.js');
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-test-callback'] === '1') {
        request.callbackPrincipal = {
          kind: 'invocation',
          catId: 'codex-terra',
          userId: 'owner-1',
          threadId: 'thread-reviewer',
          invocationId: 'invocation-1',
        };
      }
    });
    await app.register(messageActionsRoutes, {
      ownerUserId: 'owner-1',
      legacyLocalReviewDispositionService: {
        async inspect(input) {
          inspections.push(input);
          return {
            outcome: 'eligible',
            sourceMessageId: input.sourceMessageId,
            leaseId: 'lease-1',
            generation: 1,
            subjectRef: 'pr:owner/repo#4074',
            reviewerCatId: 'codex-terra',
            predecessorCatId: 'codex-sol',
            predecessorThreadId: 'thread-author',
            reviewedHeadSha: '6a907b316a907b316a907b316a907b316a907b31',
          };
        },
        async settle(input) {
          settlements.push(input);
          return {
            outcome: 'committed',
            replayed: false,
            leaseId: 'lease-1',
            generation: 1,
            decisionMessageId: 'decision-message-1',
            queueEntryId: 'queue-entry-1',
          };
        },
      },
      messageStore: {},
      socketManager: {},
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('direct operator can inspect the exact message and receives only typed lease facts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/messages/message-terminal-1/legacy-local-review-disposition',
      headers: { 'x-cat-cafe-user': 'owner-1' },
    });

    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json();
    assert.equal(body.outcome, 'eligible');
    assert.equal(body.subjectRef, 'pr:owner/repo#4074');
    assert.equal(body.reviewedHeadSha, '6a907b316a907b316a907b316a907b316a907b31');
    assert.deepEqual(inspections, [{ sourceMessageId: 'message-terminal-1', ownerUserId: 'owner-1' }]);
  });

  test('direct operator settles one explicit verdict and callback/cross-owner callers fail closed', async () => {
    const committed = await app.inject({
      method: 'POST',
      url: '/api/messages/message-terminal-1/legacy-local-review-disposition',
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: { decisionId: 'decision-1', verdict: 'changes_requested' },
    });
    assert.equal(committed.statusCode, 200, committed.payload);
    assert.equal(committed.json().outcome, 'committed');
    assert.equal(settlements.length, 1);
    assert.deepEqual(settlements[0], {
      sourceMessageId: 'message-terminal-1',
      ownerUserId: 'owner-1',
      decisionId: 'decision-1',
      verdict: 'changes_requested',
      now: settlements[0].now,
    });
    assert.equal(typeof settlements[0].now, 'number');

    const callback = await app.inject({
      method: 'POST',
      url: '/api/messages/message-terminal-1/legacy-local-review-disposition',
      headers: { 'x-cat-cafe-user': 'owner-1', 'x-test-callback': '1' },
      payload: { decisionId: 'decision-2', verdict: 'approved' },
    });
    assert.equal(callback.statusCode, 403, callback.payload);

    const foreignOwner = await app.inject({
      method: 'POST',
      url: '/api/messages/message-terminal-1/legacy-local-review-disposition',
      headers: { 'x-cat-cafe-user': 'owner-2' },
      payload: { decisionId: 'decision-3', verdict: 'approved' },
    });
    assert.equal(foreignOwner.statusCode, 403, foreignOwner.payload);
    assert.equal(settlements.length, 1, 'unauthorized requests must not reach the lifecycle service');
  });

  test('invalid verdicts and absent service are not accepted as recovery authority', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/messages/message-terminal-1/legacy-local-review-disposition',
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: { decisionId: 'decision-4', verdict: 'commented' },
    });
    assert.equal(invalid.statusCode, 400, invalid.payload);

    const unavailable = Fastify();
    const { messageActionsRoutes } = await import('../dist/routes/message-actions.js');
    await unavailable.register(messageActionsRoutes, { messageStore: {}, socketManager: {}, ownerUserId: 'owner-1' });
    const response = await unavailable.inject({
      method: 'GET',
      url: '/api/messages/message-terminal-1/legacy-local-review-disposition',
      headers: { 'x-cat-cafe-user': 'owner-1' },
    });
    assert.equal(response.statusCode, 503, response.payload);
    await unavailable.close();
  });
});
