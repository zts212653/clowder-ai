import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('RebuildJobTracker', () => {
  let RebuildJobTracker;

  async function load() {
    ({ RebuildJobTracker } = await import('../../dist/domains/memory/RebuildJobTracker.js'));
    return new RebuildJobTracker();
  }

  it('creates a job with pending status', async () => {
    const tracker = await load();
    const id = tracker.create();
    const job = tracker.get(id);
    assert.equal(job.status, 'pending');
    assert.equal(job.percent, 0);
    assert.equal(job.phase, '');
    assert.ok(job.startedAt > 0);
  });

  it('returns null for unknown id', async () => {
    const tracker = await load();
    assert.equal(tracker.get('nonexistent'), null);
  });

  it('updates progress to running', async () => {
    const tracker = await load();
    const id = tracker.create();
    tracker.updateProgress(id, 'scanning', 50);
    const job = tracker.get(id);
    assert.equal(job.status, 'running');
    assert.equal(job.phase, 'scanning');
    assert.equal(job.percent, 50);
  });

  it('clamps percent to 0-100', async () => {
    const tracker = await load();
    const id = tracker.create();
    tracker.updateProgress(id, 'scanning', 150);
    assert.equal(tracker.get(id).percent, 100);
    tracker.updateProgress(id, 'scanning', -10);
    assert.equal(tracker.get(id).percent, 0);
  });

  it('marks done with result', async () => {
    const tracker = await load();
    const id = tracker.create();
    const result = { docsIndexed: 42, docsSkipped: 3, durationMs: 1200 };
    tracker.complete(id, result);
    const job = tracker.get(id);
    assert.equal(job.status, 'done');
    assert.equal(job.percent, 100);
    assert.deepEqual(job.result, result);
    assert.ok(job.completedAt > 0);
  });

  it('marks error with message', async () => {
    const tracker = await load();
    const id = tracker.create();
    tracker.fail(id, 'disk full');
    const job = tracker.get(id);
    assert.equal(job.status, 'error');
    assert.equal(job.error, 'disk full');
    assert.ok(job.completedAt > 0);
  });

  it('rejects concurrent rebuild when one is running', async () => {
    const tracker = await load();
    const id = tracker.create();
    tracker.updateProgress(id, 'scanning', 10);
    assert.throws(() => tracker.create(), /already running/i);
  });

  it('rejects concurrent rebuild when one is pending', async () => {
    const tracker = await load();
    tracker.create();
    assert.throws(() => tracker.create(), /already running/i);
  });

  it('allows new rebuild after previous completes', async () => {
    const tracker = await load();
    const id1 = tracker.create();
    tracker.complete(id1, { docsIndexed: 1, docsSkipped: 0, durationMs: 100 });
    const id2 = tracker.create();
    assert.notEqual(id1, id2);
    assert.equal(tracker.get(id2).status, 'pending');
  });

  it('allows new rebuild after previous errors', async () => {
    const tracker = await load();
    const id1 = tracker.create();
    tracker.fail(id1, 'oops');
    const id2 = tracker.create();
    assert.notEqual(id1, id2);
    assert.equal(tracker.get(id2).status, 'pending');
  });
});
