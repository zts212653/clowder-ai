import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { PersistedQueueDelivery } from '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createDeliverFn } from '../dist/infrastructure/scheduler/delivery.js';
import { executeTaskPipeline } from '../dist/infrastructure/scheduler/execute-pipeline.js';
import {
  createAlphaBrowserTemplate,
  supportsAlphaBrowserVerification,
} from '../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { fixture } from './helpers/alpha-browser-template-fixture.js';

for (const ownership of ['owner', 'guardian']) {
  test(`Alpha ${ownership} notification remains readable by its invoked owner and rejects a foreign owner`, async () => {
    const f = fixture();
    const store = new MessageStore();
    if (ownership === 'guardian') {
      const drafts = f.runtime.alphaBrowserFailureTasks;
      f.runtime.alphaBrowserFailureTasks = async () =>
        (await drafts()).map((draft) => ({ ...draft, ownerCatId: null, ownership: 'unresolved' }));
    }
    const queue = new InvocationQueue();
    f.context.deliver = createDeliverFn({
      messageStore: store,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
      persistedQueueDelivery: new PersistedQueueDelivery({
        messages: store,
        queue,
        progress: async () => ({ kind: 'queued' }),
      }),
    });
    const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
    await spec.run.execute('alpha', 'alpha', f.context);
    const entries = queue.list('gate-owner', f.options.ownerUserId);
    assert.equal(entries.length, 1);
    const message = store.getById(entries[0].payload.messageId);
    assert.equal(message.userId, f.options.ownerUserId);
    assert.equal(message.content, entries[0].payload.content);
    assert.deepEqual(message.from, { kind: 'system', service: 'scheduler' });
    assert.deepEqual(queue.list('gate-owner', 'foreign-owner'), []);
    assert.equal(f.triggered.length, 0, 'the common Queue owns delivery');
  });
}

for (const restriction of ['scarce', 'unavailable', 'unregistered']) {
  test(`historical ${restriction} owner is preserved but only the subscription guardian is awakened`, async () => {
    const f = fixture();
    f.params.params.guardianCatId = 'guardian';
    f.options.resolveCat = (id) => (restriction === 'unregistered' && id === 'fixture-cat' ? null : id);
    f.options.isAvailable = (id) => restriction !== 'unavailable' || id !== 'fixture-cat';
    f.options.getEngagementPolicy = (id) =>
      restriction === 'scarce' && id === 'fixture-cat' ? { quota: 'weekly_subscription_scarce' } : undefined;
    const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
    for (let i = 0; i < 2; i++) await spec.run.execute('alpha', 'alpha', f.context);
    assert.equal(f.tasks.size, 1);
    assert.equal([...f.tasks.values()][0].ownerCatId, 'fixture-cat', 'historical ownership must not be rewritten');
    assert.deepEqual(
      f.delivered.map((input) => input.targetCatId),
      ['guardian', 'guardian'],
    );
    assert.match(f.delivered[0].content, /guardian.*fixture-cat/u, 'the routing decision must be visible');
  });
}

test('quota changes cannot retarget an admitted incident under the same request identity', async () => {
  const f = fixture();
  f.params.params.guardianCatId = 'guardian';
  f.options.resolveCat = (id) => id;
  let scarce = false;
  f.options.getEngagementPolicy = (id) =>
    scarce && id === 'fixture-cat' ? { quota: 'weekly_subscription_scarce' } : undefined;
  const messages = new MessageStore(),
    queue = new InvocationQueue();
  f.context.deliver = createDeliverFn({
    messageStore: messages,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
    persistedQueueDelivery: new PersistedQueueDelivery({
      messages,
      queue,
      progress: async () => ({ kind: 'queued' }),
    }),
  });
  const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  await spec.run.execute('alpha', 'alpha', f.context);
  const original = queue.list('gate-owner', 'owner')[0];
  assert.deepEqual(original.targets, ['fixture-cat']);
  scarce = true;
  await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /identity conflict|admission.*conflict/i);
  assert.equal(f.tasks.size, 1);
  assert.equal(queue.list('gate-owner', 'owner').length, 1);
  assert.deepEqual(queue.list('gate-owner', 'owner')[0], original, 'same incident cannot mutate its winning target');
  assert.equal(f.triggered.length, 0);

  // A new verification generation is a new incident; select the current guardian at its admission.
  const draft = (await f.runtime.alphaBrowserFailureTasks())[0];
  f.runtime.alphaBrowserFailureTasks = async () => [{ ...draft, generation: 2 }];
  await spec.run.execute('alpha', 'alpha', f.context);
  assert.equal(f.tasks.size, 1, 'both generations refer to the same investigation Task');
  assert.deepEqual(
    queue.list('gate-owner', 'owner').map((row) => row.targets),
    [['fixture-cat'], ['guardian']],
  );
});

test('an explicitly configured scarce guardian is preserved; an unavailable guardian cannot be awakened', async () => {
  const f = fixture();
  f.options.getEngagementPolicy = () => ({ quota: 'weekly_subscription_scarce' });
  const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  await spec.run.execute('alpha', 'alpha', f.context);
  assert.equal(f.delivered[0].targetCatId, 'fixture-cat', 'explicit schedule selection is not an inferred owner');
  f.options.isAvailable = () => false;
  await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /guardian unavailable/u);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.triggered.length, 0);
});

test('alpha failure replay keeps one Task while allowing at-least-once owner notification', async () => {
  const f = fixture(),
    template = createAlphaBrowserTemplate(f.options);
  assert.ok(template, 'alpha template must exist');
  const spec = template.createSpec('alpha-subscription', f.params);
  assert.equal(spec.run.overlap, 'skip');
  const admission = await spec.admission.gate({ taskId: spec.id });
  assert.equal(admission.run, true);
  for (let i = 0; i < 2; i++) await spec.run.execute(admission.workItems[0].signal, 'alpha', f.context);
  assert.equal(f.tasks.size, 1);
  const task = [...f.tasks.values()][0];
  assert.equal(task.ownerCatId, 'fixture-cat');
  assert.equal(task.userId, 'owner');
  assert.equal(task.threadId, 'gate-owner');
  assert.match(task.title, /P1/);
  assert.match(task.why, /exact-job/);
  assert.match(task.why, /git:head:docs\/feature.md/);
  assert.equal(f.delivered.length, 2);
  assert.equal(f.triggered.length, 0);
  assert.equal(f.delivered[0].idempotencyKey, f.delivered[1].idempotencyKey);
  assert.equal(f.delivered[0].targetCatId, 'fixture-cat');
  assert.equal(f.delivered[0].userId, 'owner');
});

for (const ownership of ['owner', 'guardian']) {
  test(`alpha retries atomic delivery after Task creation before settling (${ownership})`, async () => {
    const f = fixture();
    let attempts = 0,
      settled = 0;
    const run = f.runtime.runAlphaBrowserRevision;
    f.runtime.runAlphaBrowserRevision = async (input) => {
      const result = await run(input);
      settled++;
      return result;
    };
    if (ownership === 'guardian') {
      const drafts = f.runtime.alphaBrowserFailureTasks;
      f.runtime.alphaBrowserFailureTasks = async () =>
        (await drafts()).map((draft) => ({ ...draft, ownerCatId: null, ownership: 'unresolved' }));
    }
    const deliver = f.context.deliver;
    f.context.deliver = async (input) => {
      if (++attempts === 1) throw new Error('transient atomic delivery outage');
      return deliver(input);
    };
    const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
    await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /transient/);
    assert.equal(settled, 0);
    assert.equal(f.tasks.size, 1);
    const taskId = [...f.tasks.values()][0].id;
    await spec.run.execute('alpha', 'alpha', f.context);
    assert.equal(settled, 1);
    assert.equal(f.tasks.size, 1);
    assert.equal([...f.tasks.values()][0].id, taskId);
    assert.equal(f.delivered.length, 1);
    assert.equal(f.delivered[0].targetCatId, 'fixture-cat');
    assert.equal(f.delivered[0].idempotencyKey, `alpha-triage:exact-job:1:${taskId}`);
    assert.equal(f.triggered.length, 0, 'atomic admission never creates a second trigger');
    assert.equal([...f.tasks.values()][0].ownerCatId, ownership === 'owner' ? 'fixture-cat' : null);
  });
}

test('a full invocation queue cannot settle a revision and can retry the existing Task', async () => {
  const f = fixture();
  let attempts = 0;
  const deliver = f.context.deliver;
  f.context.deliver = async (input) => {
    if (++attempts === 1) throw new Error('queue full');
    return deliver(input);
  };
  const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /queue full/);
  assert.equal(f.tasks.size, 1);
  await spec.run.execute('alpha', 'alpha', f.context);
  assert.equal(attempts, 2);
  assert.equal(f.tasks.size, 1);
});

test('missing exact baseline or delivery target cannot silently start full alpha work', async () => {
  const f = fixture(),
    template = createAlphaBrowserTemplate(f.options);
  assert.ok(template);
  for (const params of [
    { ...f.params, deliveryThreadId: null },
    { ...f.params, params: { ...f.params.params, baselineSha: 'main' } },
    { ...f.params, params: { ...f.params.params, guardianCatId: 'unknown' } },
  ]) {
    const spec = template.createSpec('alpha-subscription', params);
    assert.equal((await spec.admission.gate({ taskId: spec.id })).run, false);
  }
});

test('incomplete execution is a failed scheduler run, not a delivered verification result', async () => {
  const f = fixture();
  const runtime = await f.options.loadRuntime();
  f.options.loadRuntime = async () => ({
    ...runtime,
    runAlphaBrowserRevision: async () => ({ status: 'incomplete', headSha: 'b'.repeat(40) }),
  });
  const task = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  const rows = [];
  await executeTaskPipeline({
    task,
    ledger: { record: (row) => rows.push(row) },
    logger: { info() {}, error() {} },
    running: new Map(),
    tickCounts: new Map(),
    lastRunAt: new Map(),
  });
  assert.equal(rows.at(-1).outcome, 'RUN_FAILED');
  assert.match(rows.at(-1).error_summary, /incomplete.*bbbbbbbb/u);
  assert.equal(f.tasks.size, 0);
});

test('Alpha browser verification is unavailable without the complete installed home runtime', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'alpha-browser-support-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, 'scripts', 'lib');
  mkdirSync(library, { recursive: true });
  const files = [
    'alpha-browser-runner.mjs',
    'alpha-browser-process.mjs',
    'alpha-browser-worker.mjs',
    'alpha-browser-checkout.mjs',
    'alpha-browser-failures.mjs',
    'gate-execution-api.mjs',
  ];
  assert.equal(supportsAlphaBrowserVerification(root), false);
  for (const file of files) writeFileSync(join(library, file), '');
  assert.equal(supportsAlphaBrowserVerification(root), true);
  for (const file of files) {
    rmSync(join(library, file));
    assert.equal(supportsAlphaBrowserVerification(root), false, `${file} is required`);
    writeFileSync(join(library, file), '');
  }
});
