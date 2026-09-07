import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createGroupUndoProof } from '../../dist/domains/thread-navigation/thread-attention-group-batch.js';

describe('F277 authenticated current-UI undo receipts', () => {
  const owner = 'f277-undo-proof-owner';
  const headers = { 'x-cat-cafe-user': owner };
  let app;
  let store;
  let root;
  let threads;
  let receipt;
  const post = (body, target = app) =>
    target.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      headers,
      payload: body,
    });
  const state = async () => ({
    metadata: await Promise.all(threads.map((thread) => store.getThreadMetadata(thread.id))),
    snapshot: (await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers })).json(),
  });
  const startApp = async () => {
    const { configThreadAttentionRoutes } = await import('../../dist/routes/config-thread-attention.js');
    const next = Fastify();
    await next.register(configThreadAttentionRoutes, { projectRoot: root, threadStore: store });
    await next.ready();
    return next;
  };
  beforeEach(async () => {
    process.env.DEFAULT_OWNER_USER_ID = owner;
    root = await mkdtemp(join(tmpdir(), 'f277-undo-proof-'));
    store = new ThreadStore();
    threads = ['a', 'b'].map((title) => store.create(owner, title, '/fixture'));
    app = await startApp();
    const saved = await post({
      action: 'organize',
      threadIds: threads.map((thread) => thread.id),
      name: 'original',
      expectedGroups: [],
    });
    assert.equal(saved.statusCode, 200, saved.payload);
    receipt = saved.json().undo;
    assert.match(receipt.proof, /^[a-f0-9]{64}$/);
  });
  afterEach(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.DEFAULT_OWNER_USER_ID;
  });

  const tampering = [
    [
      'complete closure with singleton before groups',
      (copy) => {
        copy.entries[0].before = { v: 1, groupId: 'attention_forged', order: 0 };
        copy.entries[1].before = { ...copy.entries[1].after };
      },
    ],
    [
      'fabricated two-member history',
      (copy) => {
        copy.entries.forEach((entry, order) => {
          entry.before = { v: 1, groupId: 'attention_forged', order };
        });
      },
    ],
    [
      'changed after-state',
      (copy) => {
        copy.entries[0].after.order = 9;
      },
    ],
    [
      'missing closure member',
      (copy) => {
        copy.entries.pop();
      },
    ],
    [
      'wrong proof',
      (copy) => {
        copy.proof = (copy.proof[0] === '0' ? '1' : '0') + copy.proof.slice(1);
      },
    ],
    [
      'malformed proof',
      (copy) => {
        copy.proof = 'invalid';
      },
    ],
    [
      'missing proof',
      (copy) => {
        delete copy.proof;
      },
    ],
  ];
  for (const [label, change] of tampering) {
    it(`rejects ${label} without changing membership or aliases`, async () => {
      const before = structuredClone(await state());
      const copy = structuredClone(receipt);
      change(copy);
      const response = await post({ action: 'undo', ...copy });
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error, '本次撤销凭据无法验证，当前分组保持不变');
      assert.deepEqual(await state(), before);
      const valid = await post({ action: 'undo', ...receipt });
      assert.equal(valid.statusCode, 200, 'a rejected forgery must not consume the genuine receipt');
    });
  }

  it('accepts the genuine state after JSON object property reordering', async () => {
    const reordered = receipt.entries.map(({ threadId, before, after }) => ({
      after: { order: after.order, groupId: after.groupId, v: after.v },
      before,
      threadId,
    }));
    const response = await post({ action: 'undo', entries: reordered, proof: receipt.proof });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual((await state()).snapshot.groups, []);
  });

  it('rejects a receipt from a prior API instance without changing durable Group state', async () => {
    const before = structuredClone(await state());
    const restarted = await startApp();
    try {
      const response = await post({ action: 'undo', ...receipt }, restarted);
      assert.equal(response.statusCode, 409, response.payload);
      assert.deepEqual(await state(), before);
    } finally {
      await restarted.close();
    }
  });

  it('binds receipt proof to its owner as well as its complete state', () => {
    const proof = createGroupUndoProof();
    const issued = proof.issue(owner, receipt.entries);
    assert.equal(proof.verify(owner, issued.entries, issued.proof), true);
    assert.equal(proof.verify('another-owner', issued.entries, issued.proof), false);
  });
});
