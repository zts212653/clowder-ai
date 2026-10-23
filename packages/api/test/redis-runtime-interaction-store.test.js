import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { cleanupClientKeyspace } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const skip = !REDIS_URL || process.env.CAT_CAFE_REDIS_TEST_ISOLATED !== '1';

describe('RedisRuntimeInteractionStore', { skip }, () => {
  let redis;
  let store;
  let store2;
  let RuntimeInteractionKeys;

  before(async () => {
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const module = await import('../dist/domains/runtime-interaction/stores/RedisRuntimeInteractionStore.js');
    RuntimeInteractionKeys = module.RuntimeInteractionKeys;
    const keyPrefix = `cat-cafe-test:f306:${process.pid}:`;
    redis = createRedisClient({ url: REDIS_URL, keyPrefix });
    await redis.ping();
    store = new module.RedisRuntimeInteractionStore(redis);
    store2 = new module.RedisRuntimeInteractionStore(redis);
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  const request = {
    version: 1,
    interactionId: 'redis-interaction',
    kind: 'approval',
    owner: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-1' },
    provider: {
      providerId: 'openai',
      method: 'item/fileChange/requestApproval',
      requestId: 'rpc-1',
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'provider-item',
    },
    createdAt: 1000,
    title: 'Apply file change?',
    decisions: [
      { id: 'accept', label: 'Apply', outcome: 'accept' },
      { id: 'decline', label: 'Decline', outcome: 'decline' },
    ],
  };

  it('persists staged/pending interaction truth with TTL=0', async () => {
    await store.createStaged({ request, hostEpoch: 'host-1', now: 1000 });
    await store.anchor(
      request.interactionId,
      'host-1',
      { threadId: 'thread-1', messageId: 'message-1', blockId: 'runtime-interaction:redis-interaction' },
      1001,
    );

    assert.equal(await redis.pttl(RuntimeInteractionKeys.detail(request.interactionId)), -1);
    const pending = await store.get(request.interactionId);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.revision, 2);
    assert.deepEqual(pending.returnBinding, { kind: 'provider_waiter' });
    assert.deepEqual(pending.source, { kind: 'provider_request', provider: request.provider });
    const snapshot = await store.readPendingIndexByUser('user-1');
    assert.equal(snapshot.exhaustiveness, 'complete');
    assert.deepEqual(
      snapshot.records.map((record) => record.request.interactionId),
      ['redis-interaction'],
    );
    assert.deepEqual(
      (await store.listPendingByUser('user-1')).map((record) => record.request.interactionId),
      ['redis-interaction'],
    );
  });

  it('replays and settles a historical provider record without the new binding or revision fields', async () => {
    const legacyRequest = {
      ...request,
      interactionId: 'legacy-provider-pending',
      owner: { ...request.owner, invocationId: 'legacy-provider-invocation' },
      provider: { ...request.provider, requestId: 'legacy-provider-rpc' },
    };
    await redis.hset(RuntimeInteractionKeys.detail(legacyRequest.interactionId), {
      request: JSON.stringify(legacyRequest),
      status: 'pending',
      hostEpoch: 'legacy-host',
      cardRef: JSON.stringify({
        threadId: legacyRequest.owner.threadId,
        messageId: 'legacy-provider-card',
        blockId: 'runtime-interaction:legacy-provider-pending',
      }),
      updatedAt: '900',
    });
    await redis.sadd(RuntimeInteractionKeys.active(), legacyRequest.interactionId);
    await redis.sadd(
      RuntimeInteractionKeys.activeByInvocation(legacyRequest.owner.invocationId),
      legacyRequest.interactionId,
    );
    await redis.zadd(
      RuntimeInteractionKeys.pendingByUser(legacyRequest.owner.userId),
      900,
      legacyRequest.interactionId,
    );

    const replayed = await store2.get(legacyRequest.interactionId);
    assert.equal(replayed.revision, 1);
    assert.deepEqual(replayed.source, { kind: 'provider_request', provider: legacyRequest.provider });
    assert.deepEqual(replayed.returnBinding, { kind: 'provider_waiter' });
    assert.equal(
      (await store2.readPendingIndexByUser(legacyRequest.owner.userId)).records.some(
        (record) => record.request.interactionId === legacyRequest.interactionId,
      ),
      true,
    );

    const settled = await store2.settle({
      interactionId: legacyRequest.interactionId,
      hostEpoch: 'legacy-host',
      expectedRevision: replayed.revision,
      terminal: {
        status: 'answered',
        reasonCode: 'answered',
        settledAt: 901,
        response: { kind: 'decision', decisionId: 'accept' },
      },
      now: 901,
    });
    assert.equal(settled.status, 'answered');
    assert.equal(settled.revision, 2);
    assert.equal(await redis.pttl(RuntimeInteractionKeys.detail(legacyRequest.interactionId)), -1);
  });

  it('settles once across two store instances and removes the pending index atomically', async () => {
    const terminal = {
      status: 'answered',
      reasonCode: 'answered',
      settledAt: 1002,
      response: { kind: 'decision', decisionId: 'accept' },
    };
    const results = await Promise.all([
      store.settle({ interactionId: request.interactionId, hostEpoch: 'host-1', terminal, now: 1002 }),
      store2.settle({ interactionId: request.interactionId, hostEpoch: 'host-1', terminal, now: 1002 }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await store.get(request.interactionId)).status, 'answered');
    assert.deepEqual(await store.listPendingByUser('user-1'), []);
    assert.equal(await redis.pttl(RuntimeInteractionKeys.detail(request.interactionId)), -1);
  });

  it('backfills owner history from legacy terminal hashes, with prefixed keys and TTL=0', async () => {
    const historyIds = ['history-old', 'history-new', 'history-foreign'];
    for (const [index, interactionId] of historyIds.entries()) {
      const legacyRequest = {
        ...request,
        interactionId,
        owner: { ...request.owner, userId: interactionId === 'history-foreign' ? 'other-owner' : 'history-owner' },
        provider: { ...request.provider, requestId: interactionId },
      };
      await redis.hset(RuntimeInteractionKeys.detail(interactionId), {
        request: JSON.stringify(legacyRequest),
        status: 'answered',
        hostEpoch: 'old-process',
        cardRef: JSON.stringify({
          threadId: 'thread-1',
          messageId: interactionId,
          blockId: `runtime-interaction:${interactionId}`,
        }),
        terminal: JSON.stringify({ status: 'answered', reasonCode: 'answered', settledAt: 1200 + index }),
        updatedAt: String(1200 + index),
      });
    }
    const before = await Promise.all(historyIds.map((id) => redis.hgetall(RuntimeInteractionKeys.detail(id))));
    const results = await store2.listSettledByUser('history-owner', 1);
    assert.deepEqual(
      results.map((record) => record.request.interactionId),
      ['history-new'],
    );
    assert.equal(results[0].revision, 1, 'legacy canonical records remain readable without migrations');
    assert.deepEqual(
      (await store2.listSettledByUser('history-owner', 5)).map((record) => record.request.interactionId),
      ['history-new', 'history-old'],
    );
    assert.deepEqual(await store2.listSettledByUser('never-an-owner', 5), []);
    assert.deepEqual(
      await Promise.all(historyIds.map((id) => redis.hgetall(RuntimeInteractionKeys.detail(id)))),
      before,
      'derived history indexes never change canonical records',
    );
    for (const id of historyIds) assert.equal(await redis.pttl(RuntimeInteractionKeys.detail(id)), -1);
  });

  it('bounds legacy history preparation and warm reads independently of historical size', async () => {
    const writes = redis.pipeline();
    for (let i = 0; i < 601; i++) {
      const id = `scale-history-${i}`;
      writes.hset(RuntimeInteractionKeys.detail(id), {
        request: JSON.stringify({ ...request, interactionId: id, owner: { ...request.owner, userId: 'scale-owner' } }),
        status: 'answered',
        hostEpoch: 'old',
        updatedAt: String(2000 + i),
        terminal: JSON.stringify({ status: 'answered', reasonCode: 'answered', settledAt: 2000 + i }),
        cardRef: JSON.stringify({ threadId: 'thread-1', messageId: id, blockId: `runtime-interaction:${id}` }),
      });
    }
    await writes.exec();
    await redis.del('runtime-interaction:history-index:v1');
    let detailReads = 0;
    const original = { multi: redis.multi, pipeline: redis.pipeline, scan: redis.scan };
    let scans = 0;
    for (const method of ['multi', 'pipeline'])
      redis[method] = function (...args) {
        const pipeline = original[method].apply(this, args);
        const read = pipeline.hgetall;
        pipeline.hgetall = function (...args) {
          detailReads++;
          return read.apply(this, args);
        };
        return pipeline;
      };
    redis.scan = function (...args) {
      scans++;
      return original.scan.apply(this, args);
    };
    try {
      let result;
      for (let round = 0; round < 30 && !result; round++) {
        detailReads = 0;
        try {
          result = await store2.listSettledByUser('scale-owner', 1);
        } catch (error) {
          assert.match(String(error), /history is being prepared/);
        }
        assert.ok(detailReads <= 201, `one read used ${detailReads} detail reads`);
      }
      assert.deepEqual(
        result?.map((r) => r.request.interactionId),
        ['scale-history-600'],
      );
      detailReads = 0;
      scans = 0;
      assert.equal((await store.listSettledByUser('scale-owner', 1)).length, 1);
      assert.equal(scans, 0, 'warm reads never SCAN');
      assert.equal(detailReads, 1, 'warm reads load only the requested owner window');
      assert.equal((await store.listSettledByUser('foreign-owner', 1)).length, 0);
    } finally {
      Object.assign(redis, original);
    }
  });

  it('atomically rejects a second active interaction for one invocation', async () => {
    const first = {
      ...request,
      interactionId: 'invocation-fence-first',
      owner: { ...request.owner, invocationId: 'invocation-fence' },
      provider: { ...request.provider, requestId: 'rpc-fence-first' },
    };
    const second = {
      ...first,
      interactionId: 'invocation-fence-second',
      provider: { ...first.provider, requestId: 'rpc-fence-second' },
    };
    await store.createStaged({ request: first, hostEpoch: 'host-1', now: 1500 });
    await assert.rejects(
      store2.createStaged({ request: second, hostEpoch: 'host-1', now: 1501 }),
      /active interaction already exists for invocation/,
    );
    await store.invalidate({ interactionId: first.interactionId, reasonCode: 'provider_cancelled', now: 1502 });
  });

  it('allows multiple durable conversation decisions for one requester invocation', async () => {
    const base = {
      version: 1,
      kind: 'conversation_decision',
      owner: { ...request.owner, invocationId: 'conversation-invocation' },
      createdAt: 1600,
      title: 'Choose one',
      presentation: {
        id: 'conversation-block',
        kind: 'interactive',
        v: 1,
        interactiveType: 'select',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      allowTextResponse: true,
    };
    for (const interactionId of ['conversation-a', 'conversation-b']) {
      const created = await store.createStaged({
        request: { ...base, interactionId },
        hostEpoch: 'old-host',
        now: 1600,
      });
      assert.equal(created.revision, 1);
      const anchored = await store.anchor(
        interactionId,
        'old-host',
        { threadId: 'thread-1', messageId: `message-${interactionId}`, blockId: 'conversation-block' },
        1601,
        created.revision,
      );
      assert.equal(anchored.revision, 2);
      assert.equal(anchored.returnBinding.kind, 'conversation_turn');
      assert.deepEqual(anchored.source, {
        kind: 'conversation_decision',
        requesterCatId: 'codex-sol',
        requesterThreadId: 'thread-1',
        requesterInvocationId: 'conversation-invocation',
      });
      assert.equal(await redis.pttl(RuntimeInteractionKeys.detail(interactionId)), -1);
    }
    const stagedAfterCrash = await store.createStaged({
      request: { ...base, interactionId: 'conversation-staged-restart' },
      hostEpoch: 'crashed-host',
      now: 1602,
    });
    const resumed = await store2.anchor(
      'conversation-staged-restart',
      'replacement-host',
      { threadId: 'thread-1', messageId: 'message-resumed', blockId: 'conversation-block' },
      1603,
      stagedAfterCrash.revision,
    );
    assert.equal(resumed.status, 'pending');
    assert.equal(resumed.hostEpoch, 'replacement-host');
  });

  it('persists one monotonic conversation submission claim and completes it once', async () => {
    const terminal = {
      status: 'answered',
      reasonCode: 'answered',
      settledAt: 1702,
      response: { kind: 'selection', selectedIds: ['a'] },
      operationId: 'operation-a',
      responseDigest: 'digest-a',
    };
    const submission = {
      operationId: 'operation-a',
      responseDigest: 'digest-a',
      author: 'owner',
      response: { kind: 'selection', selectedIds: ['a'] },
      terminal,
      claimedAt: 1701,
    };
    const claims = await Promise.all([
      store.claimSubmission({
        interactionId: 'conversation-a',
        expectedRevision: 2,
        submission,
        now: 1701,
      }),
      store2.claimSubmission({
        interactionId: 'conversation-a',
        expectedRevision: 2,
        submission: { ...submission, operationId: 'operation-b' },
        now: 1701,
      }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claimed = await store.get('conversation-a');
    assert.equal(claimed.revision, 3);
    assert.equal(claimed.submission.operationId, 'operation-a');

    const completed = await store.completeSubmission({
      interactionId: 'conversation-a',
      expectedRevision: 3,
      operationId: 'operation-a',
      terminal: { ...terminal, responseMessageId: 'response-message-a' },
      now: 1702,
    });
    assert.equal(completed.revision, 4);
    assert.equal(completed.status, 'answered');
    assert.equal(completed.submission, undefined);
    assert.deepEqual(
      await store2.completeSubmission({
        interactionId: 'conversation-a',
        expectedRevision: 3,
        operationId: 'operation-a',
        terminal,
        now: 1702,
      }),
      null,
    );
  });

  it('settles a conversation directly once and atomically removes every pending index', async () => {
    const directRequest = {
      version: 1,
      interactionId: 'conversation-direct-settle',
      kind: 'conversation_decision',
      owner: { ...request.owner, invocationId: 'conversation-direct-invocation' },
      createdAt: 1720,
      title: 'Still needed?',
      presentation: {
        id: 'conversation-direct-block',
        kind: 'interactive',
        v: 1,
        interactiveType: 'select',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
      allowTextResponse: true,
    };
    const staged = await store.createStaged({ request: directRequest, hostEpoch: 'host-1', now: 1720 });
    const pending = await store.anchor(
      directRequest.interactionId,
      'host-1',
      {
        threadId: 'thread-1',
        messageId: 'message-conversation-direct',
        blockId: 'conversation-direct-block',
      },
      1721,
      staged.revision,
    );
    const terminal = {
      status: 'cancelled',
      reasonCode: 'withdrawn',
      settledAt: 1722,
      operationId: 'withdraw-direct',
      responseDigest: 'withdraw-direct-digest',
    };

    assert.equal(
      await store2.settleConversation({
        interactionId: directRequest.interactionId,
        expectedRevision: pending.revision - 1,
        terminal,
        now: terminal.settledAt,
      }),
      null,
      'a stale revision must not settle the record',
    );
    const settled = await store.settleConversation({
      interactionId: directRequest.interactionId,
      expectedRevision: pending.revision,
      terminal,
      now: terminal.settledAt,
    });
    assert.equal(settled.status, 'cancelled');
    assert.equal(settled.revision, pending.revision + 1);
    assert.equal(settled.terminal.operationId, 'withdraw-direct');
    assert.equal(
      (await store2.listPendingByUser('user-1')).some(
        (record) => record.request.interactionId === directRequest.interactionId,
      ),
      false,
      'the settled record leaves the owner pending index atomically',
    );
    assert.equal(await redis.sismember(RuntimeInteractionKeys.active(), directRequest.interactionId), 0);
    assert.equal(
      await redis.sismember(
        RuntimeInteractionKeys.activeByInvocation(directRequest.owner.invocationId),
        directRequest.interactionId,
      ),
      0,
    );
    assert.equal(
      await store2.settleConversation({
        interactionId: directRequest.interactionId,
        expectedRevision: pending.revision,
        terminal,
        now: terminal.settledAt,
      }),
      null,
      'the same stale revision cannot settle twice',
    );
  });

  it('keeps Redis conversation transitions in parity with the canonical source and binding invariant', async () => {
    const mismatchedRequest = {
      version: 1,
      interactionId: 'conversation-source-mismatch',
      kind: 'conversation_decision',
      owner: { ...request.owner, invocationId: 'conversation-source-mismatch-invocation' },
      createdAt: 1730,
      title: 'Choose safely',
      presentation: {
        id: 'conversation-source-mismatch-block',
        kind: 'interactive',
        v: 1,
        interactiveType: 'select',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
      allowTextResponse: true,
    };
    const staged = await store.createStaged({ request: mismatchedRequest, hostEpoch: 'host-1', now: 1730 });
    const pending = await store.anchor(
      mismatchedRequest.interactionId,
      'host-1',
      {
        threadId: 'thread-1',
        messageId: 'message-conversation-source-mismatch',
        blockId: 'conversation-source-mismatch-block',
      },
      1731,
      staged.revision,
    );
    await redis.hset(
      RuntimeInteractionKeys.detail(mismatchedRequest.interactionId),
      'source',
      JSON.stringify({ kind: 'provider_request', provider: request.provider }),
    );
    const terminal = {
      status: 'answered',
      reasonCode: 'answered',
      settledAt: 1732,
      response: { kind: 'selection', selectedIds: ['yes'] },
      operationId: 'source-mismatch-operation',
      responseDigest: 'source-mismatch-digest',
    };
    const submission = {
      operationId: terminal.operationId,
      responseDigest: terminal.responseDigest,
      author: 'owner',
      response: terminal.response,
      terminal,
      claimedAt: 1732,
    };

    assert.equal(
      await store.claimSubmission({
        interactionId: mismatchedRequest.interactionId,
        expectedRevision: pending.revision,
        submission,
        now: 1732,
      }),
      null,
    );
    await redis.hset(
      RuntimeInteractionKeys.detail(mismatchedRequest.interactionId),
      'submission',
      JSON.stringify(submission),
    );
    await assert.rejects(
      store.completeSubmission({
        interactionId: mismatchedRequest.interactionId,
        expectedRevision: pending.revision,
        operationId: terminal.operationId,
        terminal,
        now: 1732,
      }),
      /source\/return binding does not match/,
    );
    await redis.hdel(RuntimeInteractionKeys.detail(mismatchedRequest.interactionId), 'submission');
    await assert.rejects(
      store.settleConversation({
        interactionId: mismatchedRequest.interactionId,
        expectedRevision: pending.revision,
        terminal,
        now: 1732,
      }),
      /source\/return binding does not match/,
    );
    await redis.hset(
      RuntimeInteractionKeys.detail(mismatchedRequest.interactionId),
      'source',
      JSON.stringify(pending.source),
    );
    await store.invalidate({
      interactionId: mismatchedRequest.interactionId,
      expectedRevision: pending.revision,
      reasonCode: 'confirmation_unavailable',
      now: 1733,
    });
  });

  it('does not let stale publication invalidation erase a newly claimed conversation response', async () => {
    const source = await store.get('conversation-b');
    const submission = {
      operationId: 'publication-race-answer',
      responseDigest: 'publication-race-digest',
      author: 'owner',
      response: { kind: 'selection', selectedIds: ['b'] },
      terminal: {
        status: 'answered',
        reasonCode: 'answered',
        settledAt: 1750,
        operationId: 'publication-race-answer',
        responseDigest: 'publication-race-digest',
      },
      claimedAt: 1750,
    };
    const claimed = await store.claimSubmission({
      interactionId: 'conversation-b',
      expectedRevision: source.revision,
      submission,
      now: 1750,
    });
    assert.equal(claimed.revision, source.revision + 1);
    assert.equal(
      await store2.invalidate({
        interactionId: 'conversation-b',
        expectedRevision: source.revision,
        reasonCode: 'surface_publication_failed',
        now: 1751,
      }),
      null,
    );
    assert.equal((await store.get('conversation-b')).submission.operationId, 'publication-race-answer');
  });

  it('invalidates every old-host active record without touching terminal history', async () => {
    const oldRequest = {
      ...request,
      interactionId: 'old-pending',
      owner: { ...request.owner, invocationId: 'inv-old' },
      provider: { ...request.provider, requestId: 'rpc-2' },
    };
    const newRequest = {
      ...request,
      interactionId: 'new-pending',
      owner: { ...request.owner, invocationId: 'inv-new' },
      provider: { ...request.provider, requestId: 'rpc-3' },
    };
    await store.createStaged({ request: oldRequest, hostEpoch: 'old-host', now: 2000 });
    await store.anchor(
      oldRequest.interactionId,
      'old-host',
      { threadId: 'thread-1', messageId: 'message-old', blockId: 'runtime-interaction:old-pending' },
      2001,
    );
    await store.createStaged({ request: newRequest, hostEpoch: 'new-host', now: 2000 });

    const invalidated = await store2.invalidateActiveFromOtherHostEpoch('new-host', 'host_restarted', 2002);
    assert.deepEqual(
      invalidated.map((record) => record.request.interactionId),
      ['old-pending'],
    );
    assert.equal((await store.get('old-pending')).terminal.reasonCode, 'host_restarted');
    assert.equal((await store.get('new-pending')).status, 'staged');
    assert.equal((await store.get('conversation-b')).status, 'pending');
    assert.equal((await store.get('conversation-b')).submission.operationId, 'publication-race-answer');
    assert.equal((await store.get('redis-interaction')).status, 'answered');
  });

  it('preserves empty arrays and request numbers exactly across Lua lifecycle transitions', async () => {
    const formRequest = {
      ...request,
      interactionId: 'empty-required',
      owner: { ...request.owner, invocationId: 'inv-empty-required' },
      kind: 'elicitation',
      mode: 'form',
      message: 'Optional configuration',
      requestedSchema: {
        type: 'object',
        properties: { region: { type: 'string' } },
        required: [],
        additionalProperties: false,
      },
      createdAt: 123456789012345,
      decisions: [{ id: 'accept', label: 'Submit', outcome: 'accept' }],
    };
    await store.createStaged({ request: formRequest, hostEpoch: 'host-1', now: 3000 });
    await store.anchor(
      formRequest.interactionId,
      'host-1',
      { threadId: 'thread-1', messageId: 'message-empty', blockId: 'runtime-interaction:empty-required' },
      3001,
    );
    const anchored = await store.get(formRequest.interactionId);
    assert.deepEqual(anchored.request.requestedSchema.required, []);
    assert.equal(anchored.request.createdAt, formRequest.createdAt);

    const questionRequest = {
      ...request,
      interactionId: 'empty-secret-ids',
      owner: { ...request.owner, invocationId: 'inv-empty-secret-ids' },
      kind: 'question',
      questions: [{ id: 'environment', header: 'Environment', question: 'Where?' }],
    };
    delete questionRequest.decisions;
    await store.createStaged({ request: questionRequest, hostEpoch: 'host-1', now: 3100 });
    await store.anchor(
      questionRequest.interactionId,
      'host-1',
      { threadId: 'thread-1', messageId: 'message-question', blockId: 'runtime-interaction:empty-secret-ids' },
      3101,
    );
    await store.settle({
      interactionId: questionRequest.interactionId,
      hostEpoch: 'host-1',
      now: 3102,
      terminal: {
        status: 'answered',
        reasonCode: 'answered',
        settledAt: 3102,
        response: {
          kind: 'answers',
          answeredQuestionIds: ['environment'],
          secretQuestionIds: [],
        },
      },
    });
    assert.deepEqual((await store.get(questionRequest.interactionId)).terminal.response.secretQuestionIds, []);
  });
});
