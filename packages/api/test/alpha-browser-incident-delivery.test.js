import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { createAlphaBrowserTemplate } from '../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { incidentFixture } from './helpers/alpha-browser-incident-fixture.js';
import { fixture } from './helpers/alpha-browser-template-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('alpha-incident');

test('26 matching revisions retain one repair Task and one durable wake, including after first delivery is consumed', async () => {
  const f = incidentFixture();
  await f.run();
  const first = f.tasks.listByThread('gate-owner')[0];
  const entry = f.queue.list('gate-owner', 'owner')[0];
  await f.messages.markDelivered(entry.payload.messageId, Date.now());
  assert.ok(await f.queue.terminalizeEntryDurable('gate-owner', 'owner', entry.id));
  f.tasks.update(first.id, { status: 'doing', why: 'Author is fixing the cause; targeted verification is pending.' });
  for (let i = 1; i < 26; i++) {
    f.next();
    await f.run();
  }
  assert.equal(f.tasks.listByThread('gate-owner').length, 1, 'recurrence must not create 26 investigation tickets');
  assert.equal(f.queue.list('gate-owner', 'owner').length, 0, 'consumed wake must not recur');
  assert.equal(f.tasks.get(first.id).status, 'doing');
  assert.match(f.tasks.get(first.id).why, /Author is fixing/u, 'automated recurrence must not overwrite repair work');
  assert.match(f.messages.getById(entry.payload.messageId).content, /修复|repair/u);
});

test('concurrent incident admission cannot overwrite a repair accepted by the winning author', async () => {
  const f = incidentFixture();
  const upsert = f.tasks.upsertBySubject.bind(f.tasks);
  let first = true;
  f.tasks.upsertBySubject = (input, condition) => {
    const task = upsert(input, condition);
    if (!first) return task;
    first = false;
    return f.tasks.update(task.id, { status: 'doing', why: 'winner is fixing the root cause' });
  };
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.tasks.listByThread('gate-owner').length, 1);
  assert.equal(f.tasks.listByThread('gate-owner')[0].why, 'winner is fixing the root cause');
  assert.equal(f.queue.list('gate-owner', 'owner').length, 1);
});

test('a changed symptom and recurrence after a closed repair both get new work without rewriting old Tasks', async () => {
  const f = incidentFixture();
  await f.run();
  const original = f.tasks.listByThread('gate-owner')[0];
  f.tasks.update(original.id, { status: 'done', why: 'Repair and verification evidence recorded by its owner.' });
  f.next();
  await f.run();
  f.next();
  await f.run();
  assert.equal(f.tasks.listByThread('gate-owner').length, 2);
  assert.equal(f.tasks.get(original.id).status, 'done');
  const reopened = f.tasks.listByThread('gate-owner').find((t) => t.id !== original.id);
  assert.match(reopened.why, new RegExp(original.id));
  f.differentFailure();
  f.next();
  await f.run();
  assert.equal(f.tasks.listByThread('gate-owner').length, 3);
  assert.equal(f.queue.list('gate-owner', 'owner').length, 3);
});

test('a failed atomic delivery retries the same repair Task even when the next observation is a new revision', async () => {
  const f = incidentFixture();
  const deliver = f.context.deliver;
  let attempts = 0;
  f.context.deliver = async (value) => {
    if (++attempts === 1) throw new Error('temporary admission outage');
    return deliver(value);
  };
  await assert.rejects(f.run(), /temporary admission outage/u);
  const first = f.tasks.listByThread('gate-owner')[0];
  f.next();
  await f.run();
  assert.deepEqual(
    f.tasks.listByThread('gate-owner').map((t) => t.id),
    [first.id],
  );
  assert.equal(f.queue.list('gate-owner', 'owner').length, 1);
});

test('a canonical repair owned by another user or thread cannot be reused or delivered', async () => {
  for (const scope of [{ userId: 'foreign' }, { threadId: 'foreign' }]) {
    const f = incidentFixture();
    f.tasks.create({
      kind: 'work',
      subjectKey: `alpha-browser-incident:${'d'.repeat(64)}`,
      title: 'foreign repair',
      createdBy: 'system',
      ownerCatId: 'fixture-cat',
      userId: 'owner',
      threadId: 'gate-owner',
      ...scope,
    });
    await assert.rejects(f.run(), /owner conflict/u);
    assert.equal(f.queue.list('gate-owner', 'owner').length, 0);
  }
});

test('three closed repair cycles retain every predecessor and one open successor', async () => {
  const f = incidentFixture();
  await f.run();
  let previous;
  for (let i = 0; i < 3; i++) {
    const open = f.tasks.listByThread('gate-owner').filter((t) => t.status !== 'done');
    assert.equal(open.length, 1);
    if (previous) assert.match(open[0].why, new RegExp(previous));
    previous = open[0].id;
    f.tasks.update(previous, { status: 'done' });
    f.next();
    await f.run();
  }
  assert.equal(f.tasks.listByThread('gate-owner').length, 4);
  assert.equal(f.tasks.listByThread('gate-owner').filter((t) => t.status !== 'done').length, 1);
});

test('a changed eligible notification target has its own one-time admission while the repair owner stays canonical', async () => {
  const f = incidentFixture();
  f.params.params.guardianCatId = 'guardian';
  f.options.resolveCat = (id) => id;
  await f.run();
  f.options.isAvailable = (id) => id !== 'fixture-cat';
  f.next();
  await f.run();
  f.next();
  await f.run();
  assert.equal(f.tasks.listByThread('gate-owner').length, 1);
  assert.equal(f.tasks.listByThread('gate-owner')[0].ownerCatId, 'fixture-cat');
  assert.deepEqual(
    f.queue.list('gate-owner', 'owner').map((e) => e.targets),
    [['fixture-cat'], ['guardian']],
  );
});

test('an unresolved validation failure has the explicitly configured guardian as its repair owner', async () => {
  const f = fixture();
  const tasks = new TaskStore();
  f.options.tasks = tasks;
  const original = f.runtime.alphaBrowserFailureTasks;
  f.runtime.alphaBrowserFailureTasks = async () =>
    (await original()).map((draft) => ({
      ...draft,
      kind: 'validation-incomplete',
      ownerCatId: null,
      ownership: 'unresolved',
      ownerSourceRef: null,
    }));
  await createAlphaBrowserTemplate(f.options)
    .createSpec('alpha-subscription', f.params)
    .run.execute('alpha', 'alpha', f.context);
  assert.equal(tasks.listByThread('gate-owner')[0].ownerCatId, 'fixture-cat');
  assert.match(tasks.listByThread('gate-owner')[0].why, /guardian|守护/u);
});

test('Redis restart retains repair, reminder and withdrawal receipts while later symptoms still wake once', async (t) => {
  const client = owned.client('restart:');
  const stores = () => ({
    tasks: new RedisTaskStore(client, { ttlSeconds: 0 }),
    messages: new RedisMessageStore(client, { ttlSeconds: 0 }),
    queue: new InvocationQueue(new RedisQueueLedgerStore(client)),
  });
  const original = incidentFixture(stores());
  await original.run();
  const [task] = await original.tasks.listByThread('gate-owner');
  const [wake] = original.queue.list('gate-owner', 'owner');
  await original.messages.markDelivered(wake.payload.messageId, Date.now());
  await original.queue.terminalizeEntryDurable('gate-owner', 'owner', wake.id);
  await original.tasks.update(task.id, { status: 'doing', why: 'repair in progress before restart' });
  const reopened = incidentFixture(stores());
  await reopened.queue.hydrateFromLedger(reopened.messages);
  reopened.next();
  await reopened.run();
  assert.deepEqual(
    (await reopened.tasks.listByThread('gate-owner')).map((t) => t.id),
    [task.id],
  );
  assert.equal((await reopened.tasks.get(task.id)).why, 'repair in progress before restart');
  assert.equal(reopened.queue.list('gate-owner', 'owner').length, 0);
  assert.equal(await client.ttl(`msg:${wake.payload.messageId}`), -1, 'consumed delivery receipt stays durable');
  let now = Date.now() + 24 * 60 * 60_000 + 1;
  t.mock.method(Date, 'now', () => now);
  await reopened.run();
  const [reminder] = reopened.queue.list('gate-owner', 'owner');
  assert.ok(reminder);
  await reopened.messages.markCanceled(reminder.payload.messageId);
  await reopened.queue.terminalizeEntryDurable('gate-owner', 'owner', reminder.id);
  const again = incidentFixture(stores());
  await again.queue.hydrateFromLedger(again.messages);
  now += 24 * 60 * 60_000 + 1;
  await again.run();
  assert.equal(again.queue.list('gate-owner', 'owner').length, 0, 'canceled reminder remains canceled after restart');
  again.differentFailure();
  again.next();
  await again.run();
  assert.equal((await again.tasks.listByThread('gate-owner')).length, 2);
  assert.equal(again.queue.list('gate-owner', 'owner').length, 1);
});
