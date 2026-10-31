import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBallCustodyTaskEvents } from '../dist/domains/ball-custody/BallCustodyTaskStore.js';
import { TaskActionSuccessorLifecycle } from '../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';

function fixture() {
  const raw = new TaskStore();
  let reads = 0;
  let completions = 0;
  const lifecycle = new TaskActionSuccessorLifecycle({
    leaseStore: {
      async getByIdentity() {
        reads++;
        throw new Error('lease storage unavailable');
      },
      async listActiveTaskLeases() {
        return [];
      },
    },
    completionService: {
      async complete() {
        completions++;
        throw new Error('lease completion unavailable');
      },
    },
  });
  const store = withBallCustodyTaskEvents(raw, { async record() {} }, undefined, lifecycle);
  return { raw, store, counts: () => ({ reads, completions }) };
}
test('ordinary Task completion returns durable success without consulting a lease', async () => {
  const f = fixture();
  const task = await f.store.create({
    threadId: 'owner-thread',
    title: 'Deliver original work',
    why: 'Original scope',
    ownerCatId: 'codex',
    createdBy: 'codex',
    userId: 'task-user',
  });
  const done = await f.store.update(task.id, { status: 'done' });
  assert.equal(done?.status, 'done');
  assert.deepEqual(f.counts(), { reads: 0, completions: 0 });
  assert.deepEqual(await f.raw.get(task.id), done);
});
test('the surviving eval-case namespace still requires its actual lease contract', async () => {
  const f = fixture();
  const task = await f.store.create({
    threadId: 'owner-thread',
    title: 'Evaluate the repair',
    why: 'F266 responsibility',
    subjectKey: 'eval-case:real-case:repair',
    ownerCatId: 'codex',
    createdBy: 'codex',
    userId: 'task-user',
  });
  await assert.rejects(Promise.resolve(f.store.update(task.id, { status: 'done' })), /lease storage unavailable/);
  assert.equal(f.counts().reads, 1);
});
