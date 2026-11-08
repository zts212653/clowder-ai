import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  rawDurableGateRecord,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { createAlphaManagedControl } from '../dist/infrastructure/scheduler/templates/alpha-managed-control.js';
import { alphaManagedFixture, until } from './helpers/alpha-managed-scheduler-fixture.js';

const principal = { userId: 'owner', threadId: 'alpha-thread', catId: 'codex-astra' };
const consumer = {
  kind: 'alpha_revision_v1',
  subscriptionId: 'approved-alpha-schedule',
  s3JobId: `alpha-browser-${'a'.repeat(64)}`,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
};

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'managed-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const control = createAlphaManagedControl({
    repoRoot: process.cwd(),
    principal,
    subscriptionId: consumer.subscriptionId,
    dataRoot: root,
  });
  const prepared = await control({ action: 'prepare', consumer });
  const service = new ManagedJobService(root);
  const job = service.resolve(prepared.jobId);
  assert.equal(
    writeDurableGateRecord(job, {
      ...rawDurableGateRecord(job),
      state: 'terminal',
      terminalStatus: 'failed',
      attemptToken: 'original-attempt',
      cleanupProven: true,
      result: { exitCode: 7, timedOut: false, durationMs: 10 },
      updatedAt: Date.now(),
    }),
    true,
  );
  const before = rawDurableGateRecord(job);
  const transitions = service.transitions(principal, job.jobId);
  return {
    root,
    control,
    service,
    job,
    unchanged() {
      assert.deepEqual(rawDurableGateRecord(job), before, 'observation cannot rewrite the original business row');
      assert.deepEqual(service.transitions(principal, job.jobId), transitions);
      assert.equal(service.list().length, 1, 'contention cannot admit another command');
    },
  };
}

async function holdLock(t, root, durationMs) {
  const child = fork(
    new URL('./helpers/managed-job-lock-holder.mjs', import.meta.url),
    [join(root, 'managed-jobs/supervisor.sqlite'), String(durationMs)],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(5000) }),
    closed.then(([code, signal]) => {
      throw new Error(`lock holder exited before ready: ${code}/${signal}: ${stderr}`);
    }),
  ]);
  return {
    closed,
    async release() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}

async function healthRequest(t) {
  const server = createServer((_req, res) => res.end('ready'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const started = performance.now();
  return {
    response: new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${server.address().port}`, (res) => {
        res.resume();
        res.once('end', () => resolve(performance.now() - started));
      }).once('error', reject);
    }),
  };
}

test(
  'Alpha status lock waiting leaves the API responsive and reads the original failed job',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const { closed } = await holdLock(t, f.root, 900);
    const { response } = await healthRequest(t);
    const pending = f.control({ action: 'inspect', jobId: f.job.jobId });
    const healthMs = await response;
    const status = await pending;
    await closed;
    assert.equal(status.jobId, f.job.jobId);
    assert.equal(status.state, 'failed');
    assert.equal(status.result.exitCode, 7);
    assert.equal(status.attemptToken, 'original-attempt');
    assert.equal(status.cleanupProven, true);
    f.unchanged();
    t.diagnostic(JSON.stringify({ healthMs, state: status.state }));
    assert.ok(healthMs < 250, `status query stalled the API for ${healthMs}ms`);
  },
);

test(
  'Alpha status survives a transient lock longer than one SQLite busy wait without replay',
  { timeout: 18000 },
  async (t) => {
    const f = await fixture(t);
    const { closed } = await holdLock(t, f.root, 6000);
    const pending = f.control({ action: 'inspect', jobId: f.job.jobId });
    const status = await pending;
    await closed;
    assert.equal(status.jobId, f.job.jobId);
    assert.equal(status.state, 'failed');
    assert.equal(status.result.exitCode, 7);
    assert.equal(status.attemptToken, 'original-attempt');
    f.unchanged();
  },
);

test('Alpha status still rejects foreign principals and unrelated subscriptions', async (t) => {
  const f = await fixture(t);
  const options = { repoRoot: process.cwd(), principal, subscriptionId: consumer.subscriptionId, dataRoot: f.root };
  for (const key of ['userId', 'threadId', 'catId']) {
    const foreign = createAlphaManagedControl({ ...options, principal: { ...principal, [key]: 'foreign' } });
    await assert.rejects(foreign({ action: 'inspect', jobId: f.job.jobId }), /managed_job_not_found/);
  }
  const unrelated = createAlphaManagedControl({ ...options, subscriptionId: 'another-subscription' });
  await assert.rejects(unrelated({ action: 'inspect', jobId: f.job.jobId }), /unrelated job/);
  f.unchanged();
});

test('Alpha observation survives a lock acquired between its first snapshot and reconciliation', async (t) => {
  const f = await fixture(t);
  const reconcile = ManagedJobService.prototype.reconcileJob;
  let lock;
  t.mock.method(ManagedJobService.prototype, 'reconcileJob', async function (...args) {
    lock = await holdLock(t, f.root, 6000);
    try {
      return await Reflect.apply(reconcile, this, args);
    } catch (error) {
      t.diagnostic(
        JSON.stringify({ operation: 'reconcileJob', name: error.name, code: error.code, message: error.message }),
      );
      throw error;
    }
  });
  try {
    const observed = await f.control({ action: 'inspect', jobId: f.job.jobId });
    assert.ok(lock, 'the contention window must occur during real reconciliation');
    assert.equal(observed.state, 'failed');
    assert.equal(observed.result.exitCode, 7);
    assert.equal(observed.attemptToken, 'original-attempt');
    assert.equal(observed.cleanupProven, true);
    f.unchanged();
  } finally {
    await lock?.release();
  }
});

test('Alpha observation preserves a non-busy reconciliation failure', async (t) => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('corrupt reconciliation input'), { code: 'SQLITE_CORRUPT' });
  t.mock.method(ManagedJobService.prototype, 'reconcileJob', async () => {
    throw failure;
  });
  await assert.rejects(f.control({ action: 'inspect', jobId: f.job.jobId }), (error) => error === failure);
  f.unchanged();
});

test(
  'persistent storage contention rejects within the status budget without inventing job state',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const lock = await holdLock(t, f.root, 30000);
    const { response } = await healthRequest(t);
    const started = performance.now();
    const pending = f.service.readStatus(principal, f.job.jobId);
    await assert.rejects(pending, (error) => error.name === 'SqliteError' && /database is locked/.test(error.message));
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 14000, `status must not inherit the 120s reconciliation budget: ${elapsedMs}ms`);
    assert.ok((await response) < 250, 'the API must respond while status is unavailable');
    await lock.release();
    f.unchanged();
    t.diagnostic(JSON.stringify({ persistentBusyMs: elapsedMs }));
  },
);

test('worker status preserves owner/operator checks and the requested tail and history', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.job.logPath, 'private output\n');
  const snapshot = await f.service.readStatus(principal, f.job.jobId, { tailBytes: 7 });
  assert.deepEqual(snapshot.status, f.service.get(principal, f.job.jobId));
  assert.equal(snapshot.tail, 'output\n');
  assert.deepEqual(snapshot.transitions, f.service.transitions(principal, f.job.jobId));
  const operator = new ManagedJobService(f.root, 4, principal.userId);
  assert.equal(
    (
      await operator.readStatus(
        { kind: 'operator', userId: principal.userId, threadId: principal.threadId },
        f.job.jobId,
      )
    ).status.state,
    'failed',
  );
  await assert.rejects(
    operator.readStatus({ kind: 'operator', userId: principal.userId, threadId: 'foreign' }, f.job.jobId),
    /not_found/,
  );
  await assert.rejects(
    operator.readStatus({ kind: 'operator', userId: 'foreign', threadId: principal.threadId }, f.job.jobId),
    /not_found/,
  );
  await assert.rejects(f.service.readStatus(principal, f.job.jobId, { tailBytes: 0 }), /invalid_job_tail_limit/);
  f.unchanged();
});

test('an unreadable stored record remains an error, not missing or successful', async (t) => {
  const f = await fixture(t);
  const db = new Database(join(f.root, 'managed-jobs/supervisor.sqlite'));
  const original = db.prepare('SELECT record_json FROM managed_jobs WHERE job_id=?').get(f.job.jobId).record_json;
  // A malformed recovery-independent business value cannot be retried as contention.
  db.exec('DROP INDEX managed_jobs_owner_state');
  db.prepare('UPDATE managed_jobs SET record_json=? WHERE job_id=?').run('{', f.job.jobId);
  try {
    await assert.rejects(f.service.readStatus(principal, f.job.jobId), (error) => !/not_found/.test(error.message));
  } finally {
    db.prepare('UPDATE managed_jobs SET record_json=? WHERE job_id=?').run(original, f.job.jobId);
    db.close();
  }
  f.unchanged();
});

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
