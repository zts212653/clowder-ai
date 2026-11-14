import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createAlphaBrowserTemplate } from '../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackTaskRoutes } from '../dist/routes/callback-task-routes.js';
import { incidentFixture } from './helpers/alpha-browser-incident-fixture.js';

const TRIAGE = 'codex61-sol';
function configured() {
  const f = incidentFixture();
  f.options.resolveCat = (id) => (['fixture-cat', TRIAGE, 'gemini-argon'].includes(id) ? id : null);
  f.params.params.failureTriageCatId = TRIAGE;
  return f;
}

test('explicit subscription triage owns new repair and can write it through authenticated task callbacks', async (t) => {
  const f = configured();
  await f.run();
  const [task] = f.tasks.listByThread('gate-owner');
  assert.equal(task.ownerCatId, TRIAGE, 'sending only a mention would leave the recipient unable to repair');
  assert.match(task.why, /Declared product owner: fixture-cat/u);
  assert.match(task.why, /Owner source: git:head:docs\/feature.md/u);
  assert.equal(task.subjectKey, `alpha-browser-incident:${'d'.repeat(64)}`);
  assert.deepEqual(
    f.queue.list('gate-owner', 'owner').map((entry) => entry.targets),
    [[TRIAGE]],
  );
  const registry = new InvocationRegistry();
  const app = Fastify();
  t.after(() => app.close());
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, registry);
    registerCallbackTaskRoutes(scope, {
      registry,
      taskStore: f.tasks,
      messageStore: f.messages,
      socketManager: { emitToUser() {}, broadcastToRoom() {} },
    });
  });
  const patch = async (cat) => {
    const { invocationId, callbackToken } = await registry.create('owner', cat, 'gate-owner');
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: task.id, status: 'doing', why: 'Checking the actual root cause.' },
    });
  };
  const accepted = await patch(TRIAGE);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(f.tasks.get(task.id).status, 'doing');
  const refused = await patch('codex-astra');
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(refused.json().error, /owned by another cat/i);
});

for (const status of ['todo', 'doing', 'blocked']) {
  test(`enabling triage preserves an existing ${status} repair and its winning notification`, async () => {
    const f = configured();
    delete f.params.params.failureTriageCatId;
    await f.run();
    const [task] = f.tasks.listByThread('gate-owner');
    f.tasks.update(task.id, { status, why: 'Existing owner evidence must remain.' });
    const before = structuredClone(f.tasks.get(task.id));
    const entries = structuredClone(f.queue.list('gate-owner', 'owner'));
    f.params.params.failureTriageCatId = TRIAGE;
    f.next();
    await f.run();
    assert.deepEqual(f.tasks.get(task.id), before);
    assert.deepEqual(f.queue.list('gate-owner', 'owner'), entries);
  });
}

test('a consumed historical blocked incident is not reassigned or awakened after enabling triage', async (t) => {
  const f = configured();
  delete f.params.params.failureTriageCatId;
  await f.run();
  const [task] = f.tasks.listByThread('gate-owner');
  const [entry] = f.queue.list('gate-owner', 'owner');
  await f.messages.markDelivered(entry.payload.messageId, Date.now());
  await f.queue.terminalizeEntryDurable('gate-owner', 'owner', entry.id);
  f.tasks.update(task.id, { status: 'blocked', why: 'Historical RED; waiting for original evidence.' });
  const before = structuredClone(f.tasks.get(task.id));
  const future = Date.now() + 3 * 24 * 60 * 60_000;
  t.mock.method(Date, 'now', () => future);
  f.params.params.failureTriageCatId = TRIAGE;
  f.next();
  await f.run();
  assert.deepEqual(f.tasks.get(task.id), before);
  assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
});

test('recurrence after a completed product-owned repair assigns only the new successor to triage', async () => {
  const f = configured();
  delete f.params.params.failureTriageCatId;
  await f.run();
  const [old] = f.tasks.listByThread('gate-owner');
  f.tasks.update(old.id, { status: 'done', why: 'Original fix and verification.' });
  const before = structuredClone(f.tasks.get(old.id));
  f.params.params.failureTriageCatId = TRIAGE;
  f.next();
  await f.run();
  assert.deepEqual(f.tasks.get(old.id), before);
  const next = f.tasks.listByThread('gate-owner').find((task) => task.id !== old.id);
  assert.equal(next.ownerCatId, TRIAGE);
  assert.match(next.why, new RegExp(old.id));
  assert.match(next.why, /Declared product owner: fixture-cat/u);
  assert.deepEqual(
    f.queue.list('gate-owner', 'owner').map((entry) => entry.targets),
    [['fixture-cat'], [TRIAGE]],
  );
});

test('triage changes cannot retarget an accepted repair or resurrect its withdrawn wake', async () => {
  const f = configured();
  await f.run();
  const [task] = f.tasks.listByThread('gate-owner');
  const [entry] = f.queue.list('gate-owner', 'owner');
  await f.messages.markCanceled(entry.payload.messageId);
  await f.queue.terminalizeEntryDurable('gate-owner', 'owner', entry.id);
  f.params.params.failureTriageCatId = 'gemini-argon';
  for (let i = 0; i < 3; i++) {
    f.next();
    await f.run();
  }
  assert.equal(f.tasks.listByThread('gate-owner').length, 1);
  assert.equal(f.tasks.get(task.id).ownerCatId, TRIAGE);
  assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
});

test('concurrent matching revisions keep one triage repair and one wake; other subscriptions keep owner routing', async () => {
  const f = configured();
  await Promise.all([f.run(), f.run()]);
  for (let i = 0; i < 3; i++) {
    f.next();
    await f.run();
  }
  assert.equal(f.tasks.listByThread('gate-owner').length, 1);
  assert.equal(f.tasks.listByThread('gate-owner')[0].ownerCatId, TRIAGE);
  assert.equal(f.queue.list('gate-owner', 'owner').length, 1);
  const other = configured();
  delete other.params.params.failureTriageCatId;
  await other.run();
  assert.equal(other.tasks.listByThread('gate-owner')[0].ownerCatId, 'fixture-cat');
  assert.deepEqual(other.queue.list('gate-owner', 'owner')[0].targets, ['fixture-cat']);
});

for (const [name, raw] of [
  ['unknown', 'unknown'],
  ['alias', 'sol'],
  ['empty', ''],
  ['whitespace', ' '],
  ['null', null],
  ['wrong type', 1],
  ['unavailable', TRIAGE],
]) {
  test(`invalid triage ${name} blocks admission and direct reporting instead of falling back to product owner`, async () => {
    const f = configured();
    f.params.params.failureTriageCatId = raw;
    if (name === 'alias') f.options.resolveCat = (id) => (id === 'sol' ? TRIAGE : id);
    if (name === 'unavailable') f.options.isAvailable = (id) => id !== TRIAGE;
    let loaded = 0;
    const load = f.options.loadRuntime;
    f.options.loadRuntime = () => {
      loaded++;
      return load();
    };
    const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
    assert.equal((await spec.admission.gate({ taskId: spec.id })).run, false);
    await assert.rejects(f.run(), /triage/i);
    assert.equal(loaded, 0);
    assert.equal(f.tasks.listByThread('gate-owner').length, 0);
    assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
  });
}

test('triage availability is revalidated before a failure can publish a task or notification', async () => {
  const f = configured();
  const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  assert.equal((await spec.admission.gate({ taskId: spec.id })).run, true);
  const run = f.runtime.runAlphaBrowserRevision;
  f.runtime.runAlphaBrowserRevision = async (input) => {
    f.options.isAvailable = (id) => id !== TRIAGE;
    return run(input);
  };
  await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /triage/i);
  assert.equal(f.tasks.listByThread('gate-owner').length, 0);
  assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
});

test('unresolved failures assign and describe the explicit triage owner while keeping ownership unresolved', async () => {
  const f = configured();
  const draft = f.runtime.alphaBrowserFailureTasks;
  f.runtime.alphaBrowserFailureTasks = async () =>
    (await draft()).map(({ incidentKey: _key, ...value }) => ({
      ...value,
      ownerCatId: null,
      ownerSourceRef: null,
      ownership: 'unresolved',
      kind: 'validation-incomplete',
    }));
  await f.run();
  const [task] = f.tasks.listByThread('gate-owner');
  assert.equal(task.ownerCatId, TRIAGE);
  assert.match(task.why, /Ownership: unresolved/u);
  assert.match(task.why, new RegExp(`值守猫 ${TRIAGE}`));
  assert.deepEqual(f.queue.list('gate-owner', 'owner')[0].targets, [TRIAGE]);
});
