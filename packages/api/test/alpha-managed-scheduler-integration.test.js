import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openAlphaBrowserSubscription } from '../../../scripts/lib/alpha-browser-subscription.mjs';
import { alphaManagedFixture } from './helpers/alpha-managed-scheduler-fixture.js';

test(
  'real scheduler -> isolated Alpha -> managed worker -> S3 terminal settles the exact revision once',
  { timeout: 30000 },
  async (t) => {
    const f = await alphaManagedFixture(t);
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(new Error('private fixture deadline')), 20000);
    try {
      await f.run(controller.signal);
    } finally {
      clearTimeout(watchdog);
    }
    const settled = openAlphaBrowserSubscription(f.input);
    try {
      assert.equal(settled.pending(), undefined);
      assert.equal(settled.list()[0].terminalStatus, 'green');
    } finally {
      settled.close();
    }
    const job = f.service.get(f.principal, f.managed.jobId);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.cleanupProven, true);
    assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
    await f.run();
    assert.equal(f.service.list().length, 1);
    assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
    assert.equal(f.tasks.size, 0);
  },
);
