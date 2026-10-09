/**
 * F202 h3c-1: the refusal contract of `PATCH /api/threads/:id/cloud-bindings`.
 *
 * The thread panel tells the owner "the connection did not change" only when the endpoint refused with
 * a `CloudBindingRefusal` code. That is honest only if every such code comes from a check made before
 * the write, and no failure after the write carries one — which is what these tests pin down.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { CLOUD_BINDING_REFUSALS } from '@cat-cafe/shared';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');

const OWNER = { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' };
const VALID = { catId: 'codex', chatUrl: 'https://chatgpt.com/c/conversation-new' };
const ORIGINAL = { codex: 'https://chatgpt.com/c/conversation-old' };

function makeStore({ thread, failAfterWrite = false }) {
  const bindings = new Map([[thread?.id, { ...ORIGINAL }]]);
  const writes = [];
  return {
    bindings,
    writes,
    get: async (id) => (thread && id === thread.id ? thread : null),
    updateCloudCatBinding: async (id, catId, chatUrl) => {
      writes.push({ id, catId, chatUrl });
      const current = bindings.get(id) ?? {};
      if (chatUrl === null) delete current[catId];
      else current[catId] = chatUrl;
      bindings.set(id, current);
    },
    getCloudCatBindings: async (id) => {
      if (failAfterWrite) throw new Error('bindings read failed after the write');
      return { ...(bindings.get(id) ?? {}) };
    },
    list: async () => [],
    listByProject: async () => [],
  };
}

async function makeApp(options) {
  const store = makeStore(options);
  const app = Fastify();
  await app.register(threadsRoutes, {
    threadStore: store,
    messageStore: { getByThread: async () => [], getByThreadBefore: async () => [] },
    taskStore: { listByThread: async () => [] },
  });
  return { app, store };
}

const OWNED = { id: 'T1', createdBy: 'alice', deletedAt: null };

/** One request per refusal the endpoint can make; each must name its code and leave the store alone. */
const REFUSALS = [
  {
    code: 'CLOUD_BINDING_AUTH_REQUIRED',
    status: 401,
    thread: OWNED,
    headers: { 'content-type': 'application/json' },
    body: VALID,
  },
  {
    code: 'CLOUD_BINDING_RESERVED_IDENTITY',
    status: 401,
    thread: OWNED,
    headers: { 'x-cat-cafe-user': 'system', 'content-type': 'application/json' },
    body: VALID,
  },
  {
    code: 'CLOUD_BINDING_INVALID_BODY',
    status: 400,
    thread: OWNED,
    headers: OWNER,
    body: { catId: 'codex', chatUrl: 'http://chatgpt.com/c/conversation-new' },
  },
  {
    code: 'CLOUD_BINDING_THREAD_NOT_FOUND',
    status: 404,
    thread: { ...OWNED, deletedAt: Date.now() },
    headers: OWNER,
    body: VALID,
  },
  {
    code: 'CLOUD_BINDING_SYSTEM_THREAD',
    status: 403,
    thread: { id: 'T1', createdBy: 'system', deletedAt: null },
    headers: OWNER,
    body: VALID,
  },
  {
    code: 'CLOUD_BINDING_NOT_OWNER',
    status: 403,
    thread: { ...OWNED, createdBy: 'mallory' },
    headers: OWNER,
    body: VALID,
  },
];

describe('F202 h3c-1: cloud-binding refusals prove that nothing was written', () => {
  let app;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  for (const refusal of REFUSALS) {
    it(`${refusal.code}: ${refusal.status}, with the code, and the binding untouched`, async () => {
      let store;
      ({ app, store } = await makeApp({ thread: refusal.thread }));
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/threads/T1/cloud-bindings',
        headers: refusal.headers,
        payload: JSON.stringify(refusal.body),
      });
      assert.equal(res.statusCode, refusal.status);
      assert.equal(res.json().code, refusal.code);
      assert.deepEqual(store.writes, []);
      assert.deepEqual(store.bindings.get('T1'), ORIGINAL);
    });
  }

  it('every refusal code the contract lists is one of the checks above', () => {
    assert.deepEqual([...REFUSALS.map((refusal) => refusal.code)].sort(), [...CLOUD_BINDING_REFUSALS].sort());
  });

  it('a failure after the write carries no refusal code: the write may have landed', async () => {
    let store;
    ({ app, store } = await makeApp({ thread: OWNED, failAfterWrite: true }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: OWNER,
      payload: JSON.stringify(VALID),
    });
    assert.equal(res.statusCode, 500);
    assert.equal(CLOUD_BINDING_REFUSALS.includes(res.json().code), false);
    // The binding did change: a client that read this failure as "nothing changed" would be wrong.
    assert.deepEqual(store.bindings.get('T1'), { codex: VALID.chatUrl });
  });

  it('a write that succeeds answers with the bindings and no code', async () => {
    ({ app } = await makeApp({ thread: OWNED }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: OWNER,
      payload: JSON.stringify({ catId: 'codex', chatUrl: null }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { bindings: {} });
  });
});
