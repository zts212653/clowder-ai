import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import {
  CREATE_TURN_EXECUTION_LUA,
  TERMINALIZE_TURN_EXECUTION_LUA,
} from '../dist/domains/cats/services/stores/redis/turn-execution-redis-scripts.js';
import { readModificationSourceExecution } from '../dist/domains/collaborative-content/modification/media-publication/source-execution.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { retiredHash } from './helpers/retired-turn-execution-fixture.js';

const redis = ownedRedisFixture('f117-execution-source');
const query = { userId: 'owner', threadId: 'thread', catId: 'codex-astra', messageId: 'private-carrier' };
const input = (id, extra = {}) => ({
  invocationId: id,
  parentInvocationId: 'parent',
  ...query,
  executionKind: 'ordinary',
  startedAt: 100,
  causal: { triggerMessageId: query.messageId },
  ...extra,
});

for (const backend of ['memory', 'Redis']) {
  test(`${backend} scoped source lookup retains terminal causality without creating delivery or read truth`, async () => {
    const client = backend === 'Redis' ? redis.client(`source-query:[*]:${randomUUID()}:`) : undefined;
    const store = client ? new RedisTurnExecutionStore(client) : new InMemoryTurnExecutionStore();
    await store.createRunning(input('exact'));
    await store.createRunning(input('late-bound', { causal: { triggerMessageId: 'other' } }));
    await store.bindCoveredMessageIds('late-bound', [query.messageId]);
    for (const [field, value] of [
      ['userId', 'foreign'],
      ['threadId', 'foreign'],
      ['catId', 'opus'],
      ['executionKind', 'routing_guard'],
    ]) {
      await store.createRunning(input(`wrong-${field}`, { [field]: value }));
    }
    await store.createRunning(input('wrong-source', { causal: { triggerMessageId: 'foreign' } }));
    await store.transitionTerminal('exact', { status: 'succeeded', endedAt: 101 });
    await store.clearResponsePending('exact');
    const reopened = client ? new RedisTurnExecutionStore(client) : store;
    const before = await reopened.get('exact');
    assert.deepEqual((await reopened.listBySource(query)).map((record) => record.invocationId).sort(), [
      'exact',
      'late-bound',
    ]);
    assert.deepEqual(await reopened.get('exact'), before);
    assert.deepEqual(await reopened.listBySource({ ...query, messageId: 'missing' }), []);
    assert.equal((await reopened.get('late-bound')).status, 'running');
    client?.disconnect();
  });
}

for (const status of ['running', 'succeeded', 'failed']) {
  test(`Redis source lookup accepts unrelated retired ${status} rows with actual Lua lifecycle fields`, async () => {
    const client = redis.client(`retired-lua:${randomUUID()}:`);
    const store = new RedisTurnExecutionStore(client);
    const old = retiredHash('old');
    // The old writer accepted this kind. Execute the real persistence scripts rather than
    // omit optional hash fields in a hand-built fixture, which masked the production failure.
    await client.eval(
      CREATE_TURN_EXECUTION_LUA,
      3,
      'turnexec:record:old',
      'turnexec:parent:legacy-parent',
      'turnexec:running',
      old.immutableIdentity,
      old.invocationId,
      old.parentInvocationId,
      old.threadId,
      old.userId,
      old.catId,
      old.executionKind,
      old.startedAt,
      old.causal,
      'open',
      '',
    );
    const terminalReason = status === 'failed' ? 'provider-error' : '';
    if (status !== 'running') {
      await client.eval(
        TERMINALIZE_TURN_EXECUTION_LUA,
        3,
        'turnexec:record:old',
        'turnexec:running',
        'turnexec:response-pending',
        status,
        '20',
        terminalReason,
        old.invocationId,
      );
    }
    const before = await client.hgetall('turnexec:record:old');
    assert.equal(before.status, status);
    assert.equal(before.endedAt, status === 'running' ? '' : '20');
    assert.equal(before.terminalReason, terminalReason);
    assert.deepEqual(await store.listBySource(query), []);
    assert.deepEqual(await client.hgetall('turnexec:record:old'), before);
    assert.equal(await client.ttl('turnexec:record:old'), -1);
  });
}

test('Redis source recovery tolerates validated unrelated retired records without rewriting history', async () => {
  const client = redis.client(`retired-source:${randomUUID()}:`);
  const store = new RedisTurnExecutionStore(client);
  await store.createRunning(input('exact'));
  const old = retiredHash('old');
  const sameScope = retiredHash('same-scope', { threadId: query.threadId });
  await client.hset('turnexec:record:old', old);
  await client.hset('turnexec:record:same-scope', sameScope);
  assert.deepEqual(
    (await store.listBySource(query)).map((record) => record.invocationId),
    ['exact'],
  );
  assert.deepEqual(await store.listBySource({ ...query, messageId: 'absent' }), []);
  assert.deepEqual(await client.hgetall('turnexec:record:old'), old);
  assert.deepEqual(await client.hgetall('turnexec:record:same-scope'), sameScope);
  assert.equal(await client.ttl('turnexec:record:old'), -1);
  await assert.rejects(
    store.createRunning(input('new-retired', { executionKind: 'freshness_supplement' })),
    /invalid executionKind/,
  );
});

test('Redis source recovery still refuses malformed, unknown or possibly matching retired executions', async () => {
  const exactScope = { threadId: query.threadId };
  const relevant = retiredHash('legacy', {
    ...exactScope,
    causal: { triggerMessageId: query.messageId, freshnessSupplementId: 'old-supplement' },
  });
  const covered = retiredHash('legacy', exactScope);
  covered.coveredMessageIds = JSON.stringify([query.messageId]);
  const coverageIdentity = JSON.parse(covered.immutableIdentity);
  coverageIdentity.causal.coveredMessageIds = [query.messageId];
  covered.coveredMessageIdsIdentity = JSON.stringify(coverageIdentity);
  const missingEnd = retiredHash('legacy');
  delete missingEnd.endedAt;
  for (const [label, old] of [
    ['matching trigger', relevant],
    ['matching late-bound coverage', covered],
    ['missing identity', { ...retiredHash('legacy'), immutableIdentity: '' }],
    ['identity mismatch', { ...retiredHash('legacy'), threadId: 'tampered' }],
    ['invalid lifecycle', { ...retiredHash('legacy'), endedAt: '9' }],
    ['running with end time', { ...retiredHash('legacy'), status: 'running' }],
    ['running with reason', { ...retiredHash('legacy'), status: 'running', endedAt: '', terminalReason: 'done' }],
    ['success without end time', { ...retiredHash('legacy', { startedAt: 0 }), endedAt: '' }],
    ['success with missing end time', missingEnd],
    ['failure without reason', { ...retiredHash('legacy'), status: 'failed' }],
    ['invalid causal', { ...retiredHash('legacy'), causal: '{' }],
    ['bad coverage identity', { ...covered, coveredMessageIdsIdentity: 'bad' }],
    ['invalid supplement identity', retiredHash('legacy', { causal: { freshnessSupplementId: 3 } })],
    ['missing same-scope causality', retiredHash('legacy', { ...exactScope, causal: {} })],
    ['missing coverage identity', { ...retiredHash('legacy'), coveredMessageIds: '["old-message"]' }],
    ['invalid fence', { ...retiredHash('legacy'), outputFence: 'mystery' }],
    ['unknown kind', retiredHash('legacy', { executionKind: 'unknown_kind' })],
    [
      'corrupt ordinary',
      { ...retiredHash('legacy', { executionKind: 'ordinary', causal: {} }), immutableIdentity: 'bad' },
    ],
  ]) {
    const client = redis.client(`retired-negative:${randomUUID()}:`);
    const store = new RedisTurnExecutionStore(client);
    await client.hset('turnexec:record:legacy', old);
    await assert.rejects(store.listBySource(query), /failed to hydrate|retired.*execution/i, label);
    assert.deepEqual(await client.hgetall('turnexec:record:legacy'), old, label);
  }
});

test('private execution lookup requires exact scope, audience and unambiguous causality; no public input reference is added', async () => {
  const messages = new MessageStore();
  const source = messages.append({
    userId: query.userId,
    threadId: query.threadId,
    from: { kind: 'external', connectorId: 'content-review' },
    source: { connector: 'content-review', label: 'owned review', meta: {} },
    content: 'private body',
    visibility: 'whisper',
    whisperTo: [query.catId],
    mentions: [query.catId],
    timestamp: 100,
    lifecycle: { kind: 'input', orderKey: '100:private', dispatchRefs: [] },
  });
  const turns = new InMemoryTurnExecutionStore();
  const exactQuery = { ...query, messageId: source.id };
  await turns.createRunning(input('exact', { causal: { triggerMessageId: source.id } }));
  const before = structuredClone(source);
  assert.equal((await readModificationSourceExecution(messages, turns, source, query.catId)).invocationId, 'exact');
  assert.equal(await readModificationSourceExecution(messages, turns, source, 'opus'), undefined);
  assert.equal(await readModificationSourceExecution(messages, turns, source, query.catId, 'unknown'), undefined);
  const exact = turns.get('exact');
  for (const patch of [
    { invocationId: 'different-child' },
    { parentInvocationId: '' },
    { parentInvocationId: 'exact' },
  ]) {
    assert.equal(
      await readModificationSourceExecution(
        messages,
        { get: () => ({ ...exact, ...patch }) },
        source,
        query.catId,
        'exact',
      ),
      undefined,
      'the requested native ID must identify a real exact child, not just a matching source',
    );
  }
  assert.equal(
    await readModificationSourceExecution(messages, turns, { ...source, userId: 'foreign' }, query.catId, 'exact'),
    undefined,
  );
  assert.equal(
    await readModificationSourceExecution(messages, turns, { ...source, threadId: 'foreign' }, query.catId, 'exact'),
    undefined,
  );
  assert.equal(
    await readModificationSourceExecution(messages, turns, { ...source, _tombstone: true }, query.catId, 'exact'),
    undefined,
  );
  await turns.createRunning(input('ambiguous', { causal: { coveredMessageIds: [source.id] } }));
  assert.equal((await turns.listBySource(exactQuery)).length, 2);
  assert.equal(await readModificationSourceExecution(messages, turns, source, query.catId), undefined);
  assert.deepEqual(messages.getById(source.id), before);
  assert.deepEqual(source.lifecycle.dispatchRefs, []);
});
