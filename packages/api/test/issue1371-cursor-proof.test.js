import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorFor } from '../dist/domains/cats/services/stores/cursor.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { safeParseExtra, serializeExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';
import { coldContext, proofFixture } from './helpers/issue1371-cursor-proof-harness.js';

test('#1371: stream metadata and generic extra patches preserve append-owned proof', async () => {
  const { store, reply, proof } = await proofFixture();
  await store.augmentStreamMetadata(reply.id, {
    thinking: 'finished',
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: 'child-opus' },
      causal: { kind: 'invocation_reply', triggerMessageId: proof.sourceMessageId },
    },
  });
  assert.deepEqual((await store.getById(reply.id)).extra.deliveryBoundary, proof);
  await store.updateExtra(reply.id, { deliveryBoundary: { ...proof, cursor: 'forged' } });
  assert.deepEqual((await store.getById(reply.id)).extra.deliveryBoundary, proof, 'generic patch cannot rewrite proof');
  await store.augmentStreamMetadata(reply.id, { extra: { deliveryBoundary: undefined } });
  assert.deepEqual((await store.getById(reply.id)).extra.deliveryBoundary, proof, 'a later patch cannot erase proof');
});

test('#1371: late metadata cannot manufacture proof on an old callback record', async () => {
  const { store, reply, proof } = await proofFixture();
  const legacy = await store.append({ ...reply, extra: { stream: reply.extra.stream, causal: reply.extra.causal } });
  await store.augmentStreamMetadata(legacy.id, { extra: { deliveryBoundary: proof } });
  await store.updateExtra(legacy.id, { deliveryBoundary: proof });
  assert.equal((await store.getById(legacy.id)).extra.deliveryBoundary, undefined);
});

test('#1371: parsed proof is strict, additive and survives independent metadata', async () => {
  const { proof } = await proofFixture();
  const extra = { deliveryBoundary: proof, targetCats: ['opus'] };
  assert.deepEqual(safeParseExtra(serializeExtra(extra)), extra);
  for (const deliveryBoundary of [
    null,
    { ...proof, v: 2 },
    { ...proof, cursor: 'raw' },
    { ...proof, sourceMessageId: '' },
    { ...proof, turnInvocationId: undefined },
  ]) {
    const parsed = safeParseExtra(serializeExtra({ ...extra, deliveryBoundary }));
    assert.equal(parsed.deliveryBoundary, undefined);
    assert.deepEqual(parsed.targetCats, ['opus']);
  }
});

test('#1371: two cold readers recover the canonical prefix once and preserve later sibling work', async () => {
  const { store, boundary } = await proofFixture();
  const later = await store.append({
    userId: 'user-1',
    threadId: 'thread-proof',
    catId: 'codex',
    content: '@opus new independent work',
    mentions: ['opus'],
    timestamp: Date.now(),
  });
  const cursors = new DeliveryCursorStore();
  const contexts = await Promise.all([coldContext(store, cursors), coldContext(store, cursors)]);
  assert.equal(await cursors.getCursor('user-1', 'opus', 'thread-proof'), boundary);
  assert.equal(await cursors.getCursor('user-1', 'codex', 'thread-proof'), undefined);
  for (const context of contexts) {
    assert.ok(context.contextText.includes('new independent work'));
    assert.doesNotMatch(context.navigationHeader, /传球|本轮输入来源/);
    assert.ok(!context.contextText.includes('source already answered'));
  }
  const newer = cursorFor((await store.getByThreadAfter('thread-proof', boundary)).find((m) => m.id === later.id));
  await cursors.ackCursor('user-1', 'opus', 'thread-proof', newer);
  await coldContext(store, cursors);
  assert.equal(await cursors.getCursor('user-1', 'opus', 'thread-proof'), newer);
});

for (const [name, mutate] of [
  ['tenant', (p) => ({ ...p, userId: 'foreign' })],
  ['thread', (p) => ({ ...p, threadId: 'foreign' })],
  ['target', (p) => ({ ...p, catId: 'codex' })],
  ['child', (p) => ({ ...p, turnInvocationId: 'foreign' })],
  ['source', (p) => ({ ...p, sourceMessageId: 'foreign' })],
  ['raw cursor', (p) => ({ ...p, cursor: p.sourceMessageId })],
  ['future cursor', (p) => ({ ...p, cursor: `v2:9999999999999999:${p.sourceMessageId}` })],
  ['wrong boundary member', (p) => ({ ...p, cursor: p.cursor.replace(p.sourceMessageId, 'other') })],
]) {
  test(`#1371: ${name} mismatch cannot authorize recovery or silently suppress the source`, async () => {
    const { store } = await proofFixture(undefined, mutate);
    const cursors = new DeliveryCursorStore();
    const context = await coldContext(store, cursors);
    assert.equal(await cursors.getCursor('user-1', 'opus', 'thread-proof'), undefined);
    assert.ok(
      context.contextText.includes('source already answered'),
      'invalid proof must not consume the source body',
    );
  });
}
