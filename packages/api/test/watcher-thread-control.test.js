import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';

test('a new thread inherits watching and an explicit close persists on that thread only', async () => {
  const threads = new ThreadStore();
  const first = await threads.create('owner');
  const other = await threads.create('owner');
  assert.equal(first.watcher, undefined);
  const closed = await threads.updateWatcherControl(first.id, 0, { enabled: false }, { changedAt: 100 });
  assert.deepEqual(closed, { revision: 1, enabled: false, changedAt: 100 });
  assert.equal((await threads.get(first.id)).watcher.enabled, false);
  assert.equal((await threads.get(other.id)).watcher, undefined);
});

test('an older undo cannot overwrite a newer control and clearing pause preserves the close', async () => {
  const threads = new ThreadStore();
  const thread = await threads.create('owner');
  await threads.updateWatcherControl(thread.id, 0, { enabled: false });
  const paused = await threads.updateWatcherControl(thread.id, 1, { pausedUntil: 9999999999999 });
  assert.equal(paused.revision, 2);
  assert.equal(await threads.updateWatcherControl(thread.id, 1, { enabled: null }), null);
  const resumed = await threads.updateWatcherControl(thread.id, 2, { pausedUntil: null }, { changedAt: 200 });
  assert.deepEqual(resumed, { revision: 3, enabled: false, changedAt: 200 });
  assert.equal(await threads.updateWatcherControl('missing-thread', 0, { enabled: false }), null);
});

test('only a reopening boundary changes thread activation; pause and restore keep the viewing interval', async () => {
  const threads = new ThreadStore();
  const thread = await threads.create('owner');
  await threads.updateWatcherControl(thread.id, 0, { enabled: false });
  const opened = await threads.updateWatcherControl(
    thread.id,
    1,
    { enabled: true },
    { changedAt: 100, startedAfterSequence: 0 },
  );
  assert.equal(opened.activationRevision, 2);
  const paused = await threads.updateWatcherControl(thread.id, 2, { pausedUntil: 10000 }, { changedAt: 150 });
  const restored = await threads.updateWatcherControl(thread.id, 3, { pausedUntil: null }, { changedAt: 200 });
  assert.equal(paused.activationRevision, opened.activationRevision);
  assert.equal(restored.activationRevision, opened.activationRevision);
  assert.equal(restored.activatedAt, 100);
});
