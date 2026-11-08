import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openAlphaBrowserSubscription } from '../../../scripts/lib/alpha-browser-subscription.mjs';
import { alphaManagedFixture, until } from './helpers/alpha-managed-scheduler-fixture.js';
import { healthRequest, holdLock } from './helpers/managed-job-contention-fixture.js';

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

test(
  'the real Alpha scheduler stays attached to one running attempt across lock contention',
  { timeout: 40000 },
  async (t) => {
    let marker;
    const f = await alphaManagedFixture(t, {
      sources(parent) {
        marker = join(parent, 'actual-execution.log');
        return {
          'sample.mjs': `import {appendFileSync} from 'node:fs';
          appendFileSync(${JSON.stringify(marker)}, 'once\\n');
          setTimeout(() => {}, 9000);`,
        };
      },
    });
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(new Error('status contention journey deadline')), 30000);
    const completed = f.run(controller.signal);
    // Keep the producer rejection observed while the test watches the live attempt.
    void completed.catch(() => undefined);
    try {
      await until(() => existsSync(marker), 'one real verification command started');
      const before = f.service.get(f.principal, f.managed.jobId);
      const { closed } = await holdLock(t, f.dataRoot, 6000);
      const { response } = await healthRequest(t);
      assert.ok((await response) < 250, 'the scheduler status read cannot monopolize HTTP');
      await closed;
      await completed;
      const after = (await f.service.readStatus(f.principal, f.managed.jobId)).status;
      assert.equal(after.state, 'succeeded');
      assert.equal(after.attemptToken, before.attemptToken);
      assert.deepEqual(after.ownerIdentity, before.ownerIdentity);
      assert.equal(after.cleanupProven, true);
      assert.equal(readFileSync(marker, 'utf8'), 'once\n');
      assert.equal(f.service.list().length, 1);
      assert.equal(f.tasks.size, 0);
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      await completed.catch(() => undefined);
    }
  },
);
