import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  deriveGrowingSourceMessageRevision,
  MessageStore,
} from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { DevelopmentScopeUnavailable } from '../../src/domains/growing/DevelopmentScopeResolver.js';
import { registerCallbackAuthHook } from '../../src/routes/callback-auth-prehandler.js';
import { registerCallbackTaskRoutes } from '../../src/routes/callback-task-routes.js';

const scope = { featureRef: 'feature:F310', phaseKey: 'B', acceptedRevision: 'a'.repeat(40) };
async function fixture(t, documents?) {
  const app = Fastify();
  t.after(() => app.close());
  const registry = new InvocationRegistry(),
    taskStore = new TaskStore(),
    messageStore = new MessageStore(),
    threadStore = new ThreadStore();
  const thread = threadStore.create('human', 'F310 accepted work', process.cwd());
  const auth = await registry.create('human', 'codex-sol', thread.id);
  registerCallbackAuthHook(app, registry);
  registerCallbackTaskRoutes(app, {
    taskStore,
    messageStore,
    threadStore,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
    developmentDocuments: documents ?? {
      readFeature: async () => ({
        ref: 'file:docs/features/F310-growing.md',
        content: '### Phase B — Accepted result',
      }),
      readPlan: async () => '<a id="child"></a>',
    },
  });
  function source(content = '继续这个 Phase B，把接受的结果做好', extra = {}) {
    return messageStore.append({
      userId: 'human',
      catId: null,
      threadId: thread.id,
      content,
      mentions: [],
      timestamp: Date.now(),
      ...extra,
    });
  }
  function payload(action, msg, rest = {}) {
    return {
      action,
      scope,
      sourceMessageRevision: deriveGrowingSourceMessageRevision(msg),
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${msg.id}`],
        idempotencyKey: msg.id,
        intendedOutcome: 'Deliver the accepted Phase B result',
      },
      ...rest,
    };
  }
  const post = (body, credentials = auth) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/development-work',
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload: body,
    });
  return { app, registry, taskStore, messageStore, threadStore, thread, source, payload, post };
}
const closure = { condition: 'Accepted result is verified', expectedSignal: 'verified' };

test('source-read uncertainty is explicitly retryable and does not mutate a Task', async (t) => {
  const f = await fixture(t, {
    readFeature: async () => {
      throw new DevelopmentScopeUnavailable('git timeout');
    },
    readPlan: async () => null,
  });
  const source = f.source();
  for (const action of ['resolve', 'admit']) {
    const response = await f.post(f.payload(action, source, action === 'admit' ? { title: 'Phase B', closure } : {}));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { result: 'scope_unverifiable', retryable: true });
  }
  assert.equal(f.taskStore.listByThread(f.thread.id).length, 0);
});

test('natural untimed development resolves, admits, and resumes one Task across authenticated invocations', async (t) => {
  const f = await fixture(t),
    first = f.source();
  const resolved = await f.post(f.payload('resolve', first));
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json().result, 'resolved');
  const admitted = await f.post(f.payload('admit', first, { title: 'Phase B', closure }));
  assert.equal(admitted.statusCode, 200);
  assert.equal(admitted.json().result, 'admitted');
  const task = admitted.json().task;
  const replay = await f.post(f.payload('admit', first, { title: 'Phase B', closure }));
  assert.equal(replay.json().task.id, task.id);
  assert.equal(replay.json().receiptRef, admitted.json().receiptRef);
  assert.deepEqual(task.entrustedWork.time, {});
  const later = f.source('接着完成这个阶段');
  const newAuth = await f.registry.create('human', 'codex-sol', f.thread.id);
  const crossInvocationReplay = await f.post(f.payload('admit', first, { title: 'Phase B', closure }), newAuth);
  assert.equal(crossInvocationReplay.json().task?.id, task.id);
  const resumed = await f.post(f.payload('resume', later, { taskId: task.id, expectedRevision: 1 }), newAuth);
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.json().result, 'resumed');
  assert.equal(resumed.json().task.id, task.id);
  assert.deepEqual(resumed.json().task.entrustedWork.admission, task.entrustedWork.admission);
  assert.equal(f.taskStore.listByThread(f.thread.id).length, 1);
});

test('adopts a legacy Task without a mirror and preserves its creation identity', async (t) => {
  const f = await fixture(t),
    msg = f.source();
  const legacy = f.taskStore.create({
    threadId: f.thread.id,
    userId: 'human',
    createdBy: 'user',
    ownerCatId: 'codex-sol',
    title: 'Existing work',
    why: 'Original history',
  });
  const scoped = { ...scope, workUnitRef: `task:work:${legacy.id}` };
  const lookup = await f.post(f.payload('resolve', msg, { scope: scoped }));
  assert.equal(lookup.json().existing.disposition, 'adopt');
  const adopted = await f.post(
    f.payload('adopt', msg, {
      scope: scoped,
      taskId: legacy.id,
      expectedSnapshot: lookup.json().existing.snapshot,
      closure,
    }),
  );
  assert.equal(adopted.json().result, 'adopted');
  assert.equal(adopted.json().task.id, legacy.id);
  assert.equal(adopted.json().task.createdBy, 'user');
  assert.equal(f.taskStore.listByThread(f.thread.id).length, 1);
});

test('callback source auth rejects forged, stale, and cross-thread sources without writing', async (t) => {
  const f = await fixture(t),
    msg = f.source();
  const body = f.payload('admit', msg, { title: 'Phase B', closure });
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/callbacks/development-work', payload: body })).statusCode,
    401,
  );
  assert.equal((await f.post({ ...body, sourceMessageRevision: `sha256:${'b'.repeat(64)}` })).statusCode, 409);
  const forged = f.source('continue', { catId: 'codex-sol' });
  assert.equal((await f.post(f.payload('admit', forged, { title: 'Phase B', closure }))).statusCode, 409);
  const elsewhere = f.threadStore.create('human', 'Elsewhere', process.cwd());
  const foreign = f.source('continue', { threadId: elsewhere.id });
  assert.equal((await f.post(f.payload('admit', foreign, { title: 'Phase B', closure }))).statusCode, 409);
  assert.equal(f.taskStore.listByThread(f.thread.id).length, 0);
});

test('foreign-thread scope collision is content-free and cannot be turned into a duplicate admission', async (t) => {
  const f = await fixture(t),
    msg = f.source();
  await f.post(f.payload('admit', msg, { title: 'private-title', closure }));
  const elsewhere = f.threadStore.create('human', 'Elsewhere', process.cwd());
  const auth = await f.registry.create('human', 'codex-sol', elsewhere.id);
  const otherSource = f.source('继续 Phase B', { threadId: elsewhere.id });
  const response = await f.post(f.payload('admit', otherSource, { title: 'no duplicate', closure }), auth);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { result: 'scope_unavailable_here' });
  assert.equal(f.taskStore.listByThread(elsewhere.id).length, 0);
});

test('resume rejects silent outcome/publication rewrites and action-inapplicable fields', async (t) => {
  const f = await fixture(t),
    msg = f.source();
  const first = await f.post(f.payload('admit', msg, { title: 'Original', closure }));
  const task = first.json().task,
    later = f.source('Continue');
  const resume = f.payload('resume', later, { taskId: task.id, expectedRevision: 1 });
  for (const patch of [
    { artifactRefs: ['artifact:new'] },
    { title: 'Renamed' },
    { closure },
    { admission: { ...resume.admission, intendedOutcome: 'Different work' } },
  ]) {
    assert.equal((await f.post({ ...resume, ...patch })).statusCode, 409);
  }
  assert.equal((await f.post(f.payload('resolve', msg, { taskId: task.id }))).statusCode, 409);
  assert.equal(f.taskStore.get(task.id).entrustedWork.revision, 1);
});
