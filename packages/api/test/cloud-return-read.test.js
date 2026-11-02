import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  CloudReturnGrantRetentionMs,
  MemoryCloudReturnGrantStore,
} from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { buildCloudReturnMessageIdempotencyKey } from '../dist/domains/cats/services/cloud-bridge/cloud-return-message.js';
import { cloudReturnProof } from '../dist/domains/cats/services/cloud-bridge/cloud-return-proof.js';
import { readCloudReturn } from '../dist/domains/cats/services/cloud-bridge/read-cloud-return.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { safeParseExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';
import { cloudReturnReadRoutes } from '../dist/routes/cloud-return-read.js';

async function fixture({ withProof = true, answerChanges = {}, keyed = true } = {}) {
  let now = 1000;
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = await threads.create('alice', 'source119 -> reply122');
  const source = await messages.append({
    from: { kind: 'agent', catId: 'codex61-sol' },
    userId: 'alice',
    threadId: thread.id,
    content: 'new source119',
    mentions: ['gpt-pro'],
    timestamp: now,
  });
  const scope = { threadId: thread.id, userId: 'alice', sourceMessageId: source.id, targetCatId: 'gpt-pro' };
  const grants = new MemoryCloudReturnGrantStore(() => now, { historyBoundary: 0 });
  await grants.issue({ ...scope, dispatchInvocationId: 'attempt119' });
  const claim = await grants.claim(scope);
  assert.equal(claim.ok, true);
  const proof = cloudReturnProof(claim);
  now = 1100;
  const answer = await messages.append({
    from: { kind: 'agent', catId: 'gpt-pro' },
    userId: 'alice',
    threadId: thread.id,
    content: 'nonempty reply122',
    mentions: [],
    origin: 'callback',
    timestamp: now,
    replyTo: source.id,
    extra: { isExplicitPost: true, ...(withProof ? { cloudBridgeReturn: proof } : {}) },
    ...(keyed ? { idempotencyKey: buildCloudReturnMessageIdempotencyKey(scope) } : {}),
    ...answerChanges,
  });
  now = 1200;
  await grants.commit(claim);
  return {
    messages,
    threads,
    source,
    answer,
    grants,
    proof,
    scope,
    query: { ...scope, dispatchInvocationId: 'attempt119' },
    setNow: (value) => {
      now = value;
    },
  };
}

test('restores durable exact reply proof outside a history page without changing messages or grant consumption', async () => {
  const f = await fixture();
  const before = JSON.stringify(await f.messages.getByThread(f.scope.threadId));
  assert.deepEqual(await readCloudReturn(f.messages, f.query), {
    status: 'matched',
    replyMessageId: f.answer.id,
    proof: f.proof,
  });
  assert.equal(JSON.stringify(await f.messages.getByThread(f.scope.threadId)), before);
  assert.deepEqual(await f.grants.claim(f.scope), { ok: false, reason: 'consumed' });
});

test('a consumed grant and matching times never manufacture missing historical attempt proof', async () => {
  const f = await fixture({ withProof: false });
  const partial = { status: 'source_replied', replyMessageId: f.answer.id };
  assert.deepEqual(await readCloudReturn(f.messages, f.query), partial);
  assert.deepEqual(await readCloudReturn(f.messages, { ...f.query, dispatchInvocationId: 'other-attempt' }), partial);
  f.setNow(1200 + CloudReturnGrantRetentionMs);
  assert.deepEqual(
    await readCloudReturn(f.messages, f.query),
    partial,
    'reply truth survives expiry without gaining attempt certainty',
  );
  await f.grants.issue({ ...f.scope, dispatchInvocationId: 'reissued' });
  const next = await f.grants.claim(f.scope);
  await f.grants.commit(next);
  assert.deepEqual(await readCloudReturn(f.messages, { ...f.query, dispatchInvocationId: 'reissued' }), partial);
  assert.equal((await f.messages.getById(f.answer.id)).extra.cloudBridgeReturn, undefined);
});

test('stored authenticated proof outlives temporary grants; malformed and old-attempt proof fail closed', async () => {
  const f = await fixture();
  f.setNow(1200 + CloudReturnGrantRetentionMs);
  assert.deepEqual(await readCloudReturn(f.messages, f.query), {
    status: 'matched',
    replyMessageId: f.answer.id,
    proof: f.proof,
  });
  assert.equal(await readCloudReturn(f.messages, { ...f.query, dispatchInvocationId: 'old-attempt' }), null);
  assert.deepEqual(safeParseExtra(JSON.stringify({ cloudBridgeReturn: f.proof })), { cloudBridgeReturn: f.proof });
  assert.equal(
    safeParseExtra(JSON.stringify({ cloudBridgeReturn: { ...f.proof, arbitraryAuthority: true } })),
    undefined,
  );
});

for (const [name, changes] of [
  ['empty placeholder', { content: '' }],
  ['whitespace placeholder', { content: '  ' }],
  ['stream output', { origin: 'stream' }],
  ['other cat', { from: { kind: 'agent', catId: 'other-cat' } }],
  ['other source', { replyTo: 'other-source' }],
  ['unrevealed whisper', { visibility: 'whisper', whisperTo: ['gpt-pro'] }],
])
  test(`rejects ${name} as completion`, async () => {
    const f = await fixture({ answerChanges: changes });
    assert.equal(await readCloudReturn(f.messages, f.query), null);
  });

test('recalled sources/replies stay hidden; a legally read legacy reply id shows source certainty only', async () => {
  const a = await fixture();
  await a.messages.softDelete(a.answer.id, 'alice');
  assert.equal(await readCloudReturn(a.messages, a.query), null);
  const b = await fixture();
  await b.messages.softDelete(b.source.id, 'alice');
  assert.equal(await readCloudReturn(b.messages, b.query), null);
  const c = await fixture({ withProof: false, keyed: false });
  assert.equal(await readCloudReturn(c.messages, c.query), null, 'no scan or guessed answer when the page lacks a ref');
  assert.deepEqual(await readCloudReturn(c.messages, { ...c.query, replyMessageId: c.answer.id }), {
    status: 'source_replied',
    replyMessageId: c.answer.id,
  });
});

test('owner read requires identity, exact thread ownership, bounded refs and exact attempt proof', async () => {
  const f = await fixture();
  const app = Fastify();
  await app.register(cloudReturnReadRoutes, { messageStore: f.messages, threadStore: f.threads });
  const url = `/api/threads/${f.scope.threadId}/messages/${f.source.id}/cloud-return?targetCatId=gpt-pro&dispatchInvocationId=attempt119`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'bob' } })).statusCode, 404);
  assert.equal(
    (await app.inject({ url, headers: { origin: 'http://evil.invalid', 'x-cat-cafe-user': 'alice' } })).statusCode,
    401,
  );
  const response = await app.inject({ url, headers: { 'x-cat-cafe-user': 'alice' } });
  assert.deepEqual(response.json(), { status: 'matched', replyMessageId: f.answer.id, proof: f.proof });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(
    (
      await app.inject({ url: url.replace('attempt119', 'old-attempt'), headers: { 'x-cat-cafe-user': 'alice' } })
    ).json(),
    { status: 'unverified' },
  );
  assert.equal(
    (await app.inject({ url: url.replace('attempt119', 'bad%00ref'), headers: { 'x-cat-cafe-user': 'alice' } }))
      .statusCode,
    400,
  );
  assert.deepEqual(await f.grants.claim(f.scope), { ok: false, reason: 'consumed' });
  await app.close();
});
