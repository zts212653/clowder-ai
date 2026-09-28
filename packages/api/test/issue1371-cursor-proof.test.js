import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallbackFinalReplacementMetadataPatch } from '../dist/domains/cats/services/agents/routing/callback-final-replacement.js';
import { legacyBatonHasSucceededReply } from '../dist/domains/cats/services/agents/routing/delivery-boundary-recovery.js';
import { cursorFor } from '../dist/domains/cats/services/stores/cursor.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { safeParseExtra, serializeExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';
import { coldContext, proofFixture } from './helpers/issue1371-cursor-proof-harness.js';

test('#1371: callback replacement and generic extra patches preserve append-owned proof', async () => {
  const { store, reply, proof } = await proofFixture();
  const patch = buildCallbackFinalReplacementMetadataPatch({
    thinkingChunks: ['finished'],
    toolEvents: [],
    richBlocks: [],
    visibleTurnInvocationId: 'child-opus',
    persistedInvocationId: 'parent',
    turnTriggerMessageId: proof.sourceMessageId,
    executionProjections: {},
  });
  await store.augmentStreamMetadata(reply.id, patch);
  assert.deepEqual((await store.getById(reply.id)).extra.deliveryBoundary, proof);
  await store.updateExtra(reply.id, { deliveryBoundary: { ...proof, cursor: 'forged' } });
  assert.deepEqual((await store.getById(reply.id)).extra.deliveryBoundary, proof, 'generic patch cannot rewrite proof');
  await store.augmentStreamMetadata(reply.id, { extra: { deliveryBoundary: undefined } });
  assert.deepEqual((await store.getById(reply.id)).extra.deliveryBoundary, proof, 'replacement cannot erase proof');
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

test('#1371: many legacy output records require at most one exact child lookup', async () => {
  const { store, source, reply } = await proofFixture();
  const messages = await store.getByThreadAfter('thread-proof', undefined, undefined, 'user-1');
  const legacy = {
    ...messages.find((m) => m.id === reply.id),
    extra: { stream: reply.extra.stream, causal: reply.extra.causal },
  };
  let reads = 0;
  const matched = await legacyBatonHasSucceededReply({
    messages: [messages[0], ...Array(1000).fill(legacy)],
    sourceMessageId: source.id,
    target: { userId: 'user-1', threadId: 'thread-proof', catId: 'opus' },
    turnExecutionStore: {
      get: async () => {
        reads++;
        throw new Error('unavailable');
      },
    },
  });
  assert.equal(matched, false);
  assert.equal(reads, 1);
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
    assert.ok(context.navigationHeader.includes('new independent work'));
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
    assert.ok(context.navigationHeader.includes('source already answered'));
  });
}
