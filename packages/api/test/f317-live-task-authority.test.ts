import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import type { SocketManager } from '../src/infrastructure/websocket/index.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackTaskRoutes } from '../src/routes/callback-task-routes.js';

async function fixture() {
  const app = Fastify();
  const registry = new InvocationRegistry();
  const { invocationId, callbackToken } = await registry.create('owner', 'codex-sol', 'home');
  registerCallbackAuthHook(app, registry);
  const store = new TaskStore();
  let current = true;
  const messages = new MessageStore();
  const options = {
    taskStore: store,
    messageStore: messages,
    socketManager: { broadcastToRoom() {}, emitToUser() {} } as unknown as SocketManager,
    liveTaskAuthority: {
      isLive: async () => true,
      run: async <T>(_query: unknown, operation: () => Promise<T>) => operation(),
      assertCurrent: async () => {
        if (!current) throw Object.assign(new Error('revoked'), { statusCode: 409 });
      },
    },
  };
  registerCallbackTaskRoutes(app, options);
  const post = (url: string, payload: object) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
  return {
    app,
    store,
    messages,
    post,
    revoke: () => {
      current = false;
    },
  };
}

test('Live Task create binds the caller; a partner and an unowned Task are outside its mutation scope', async () => {
  const f = await fixture();
  try {
    const created = await f.post('/api/callbacks/create-task', { title: 'owner work' });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().task.ownerCatId, 'codex-sol');
    const foreign = await f.post('/api/callbacks/create-task', { title: 'false delegation', ownerCatId: 'sonnet' });
    assert.equal(foreign.statusCode, 403);
    const unowned = f.store.create({ threadId: 'home', title: 'unowned', why: '', createdBy: 'user', userId: 'owner' });
    const mutation = await f.post('/api/callbacks/update-task', { taskId: unowned.id, status: 'doing' });
    assert.equal(mutation.statusCode, 403);
  } finally {
    await f.app.close();
  }
});

test('Live accepts one entrusted owner request idempotently and cannot substitute a foreign source', async () => {
  const f = await fixture();
  try {
    const source = f.messages.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'owner' },
      content: 'Compare these two reports and return a reviewable result',
      mentions: [],
      timestamp: Date.now(),
    });
    const payload = {
      title: 'Compare supplied reports',
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${source.id}`],
        intendedOutcome: 'A source-backed comparison is ready',
        idempotencyKey: `live:${source.id}`,
      },
      closure: { condition: 'The comparison is reviewable', expectedSignal: 'artifact:comparison' },
    };
    const first = await f.post('/api/callbacks/admit-entrusted-work', payload);
    assert.equal(first.statusCode, 200, first.body);
    const replay = await f.post('/api/callbacks/admit-entrusted-work', payload);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(first.json().task.id, replay.json().task.id);
    assert.equal(first.json().task.ownerCatId, 'codex-sol');
    assert.equal(f.store.listByThread('home').length, 1);
    const foreign = f.messages.append({
      userId: 'foreign',
      threadId: 'home',
      from: { kind: 'user', userId: 'foreign' },
      content: 'Foreign request',
      mentions: [],
      timestamp: Date.now(),
    });
    const denied = await f.post('/api/callbacks/admit-entrusted-work', {
      ...payload,
      admission: { ...payload.admission, sourceRefs: [`message:${foreign.id}`], idempotencyKey: 'foreign' },
    });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(f.store.listByThread('home').length, 1);
  } finally {
    await f.app.close();
  }
});

test('revocation during Task lookup prevents the subsequent write', async () => {
  const f = await fixture();
  try {
    const task = f.store.create({
      threadId: 'home',
      title: 'owned',
      why: '',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'owner',
    });
    const originalGet = f.store.get.bind(f.store);
    Object.defineProperty(f.store, 'get', {
      value: async (id: string) => {
        f.revoke();
        return originalGet(id);
      },
    });
    const reply = await f.post('/api/callbacks/update-task', { taskId: task.id, status: 'doing' });
    assert.equal(reply.statusCode, 409);
    assert.equal(originalGet(task.id)?.status, 'todo');
  } finally {
    await f.app.close();
  }
});

test('revocation while reading the admission source prevents Task creation', async () => {
  const f = await fixture();
  try {
    const source = f.messages.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'owner' },
      content: 'Please compare these reports',
      mentions: [],
      timestamp: Date.now(),
    });
    const get = f.messages.getById.bind(f.messages);
    f.messages.getById = (id) => {
      f.revoke();
      return get(id);
    };
    const reply = await f.post('/api/callbacks/admit-entrusted-work', {
      title: 'Reports',
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${source.id}`],
        intendedOutcome: 'Compare reports',
        idempotencyKey: 'source-revoked',
      },
    });
    assert.equal(reply.statusCode, 409, reply.body);
    assert.equal(f.store.listByThread('home').length, 0);
  } finally {
    await f.app.close();
  }
});

for (const action of ['update', 'close'] as const) {
  test(`revocation during entrusted Task lookup prevents its ${action} write`, async () => {
    const f = await fixture();
    try {
      const source = f.messages.append({
        userId: 'owner',
        threadId: 'home',
        from: { kind: 'user', userId: 'owner' },
        content: 'Please compare these reports',
        mentions: [],
        timestamp: Date.now(),
      });
      const admission = await f.post('/api/callbacks/admit-entrusted-work', {
        title: 'Reports',
        admission: {
          basis: 'explicit_entrustment',
          sourceRefs: [`message:${source.id}`],
          intendedOutcome: 'Compare reports',
          idempotencyKey: 'task-lookup',
        },
        closure: { condition: 'The comparison is reviewable', expectedSignal: 'artifact:comparison' },
      });
      assert.equal(admission.statusCode, 200, admission.body);
      const task = admission.json().task;
      const get = f.store.get.bind(f.store);
      Object.defineProperty(f.store, 'get', {
        value: async (id: string) => {
          f.revoke();
          return get(id);
        },
      });
      const body =
        action === 'update'
          ? { taskId: task.id, expectedRevision: task.entrustedWork.revision, status: 'doing' }
          : {
              taskId: task.id,
              expectedRevision: task.entrustedWork.revision,
              closure: {
                state: 'cancelled',
                condition: task.entrustedWork.closure.condition,
                expectedSignal: task.entrustedWork.closure.expectedSignal,
                evidenceRefs: [],
                disposition: {
                  kind: 'cancelled',
                  actorKind: 'owner',
                  actorRef: 'cat:codex-sol',
                  authorityRef: `task:item:${task.id}`,
                  dispositionRef: `thread:home#${source.id}`,
                  disposedAt: Date.now(),
                },
              },
            };
      const reply = await f.post(`/api/callbacks/${action === 'update' ? 'update' : 'close'}-entrusted-work`, body);
      assert.equal(reply.statusCode, 409, reply.body);
      assert.equal(get(task.id)?.entrustedWork?.revision, task.entrustedWork.revision);
      assert.equal(get(task.id)?.entrustedWork?.closure.state, 'open');
    } finally {
      await f.app.close();
    }
  });
}
