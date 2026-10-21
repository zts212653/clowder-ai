import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import {
  closeSupervisorStore,
  openSupervisorStore,
  withSupervisorStores,
} from '../dist/domains/managed-job/managed-job-database.js';

function history(t, count = 2283) {
  const root = mkdtempSync(join(tmpdir(), 'managed-loop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const job = {
    kind: 'command',
    recordStorage: 'sqlite_v1',
    jobId: '',
    originTaskId: '',
    supervisorEpoch: 'old',
    recordPath: join(root, 'managed-jobs/job.json'),
    logPath: join(root, 'absent.log'),
    gateReceiptPath: join(root, 'gate.json'),
    executionSlaMs: 1000,
    wallSlaMs: 1000,
    wakeTarget: { userId: 'u', threadId: 't', catId: 'codex61-sol' },
  };
  const db = openSupervisorStore(job);
  const insert = db.prepare('INSERT INTO managed_jobs VALUES (?, ?, ?, ?, ?, ?)');
  const transition = db.prepare('INSERT INTO managed_job_transitions VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `managed-job-${i.toString(16).padStart(40, '0')}`;
      const descriptor = { ...job, jobId: id, originTaskId: `task-${i}` };
      const record = {
        version: 1,
        jobId: id,
        originTaskId: descriptor.originTaskId,
        descriptor,
        state: 'terminal',
        terminalStatus: 'green',
        supervisorEpoch: 'old',
        revision: 6,
        createdAt: 10,
        updatedAt: 60,
        result: { exitCode: 0, timedOut: false, durationMs: 40 },
        padding: 'x'.repeat(1500),
      };
      insert.run(id, 'owner', `key-${i}`, 'terminal', 6, JSON.stringify(record));
      for (let r = 1; r <= 6; r++) {
        transition.run(
          id,
          r,
          'old',
          1,
          r === 6 ? 'terminal' : 'running',
          r * 10,
          JSON.stringify({ ...record, state: r === 6 ? 'terminal' : 'running', revision: r, updatedAt: r * 10 }),
        );
      }
    }
  })();
  db.close();
  return { root, service: new ManagedJobService(root), path: join(root, 'managed-jobs/supervisor.sqlite') };
}

test('a full historical reconciliation lets the API event loop progress before it finishes', async (t) => {
  const { service } = history(t);
  let serviced = false;
  const tick = new Promise((resolve) =>
    setImmediate(() => {
      serviced = true;
      resolve();
    }),
  );
  const started = performance.now();
  const rows = await service.reconcile([], 100);
  const elapsedMs = performance.now() - started;
  assert.equal(rows.length, 2283, 'historical terminal evidence remains visible');
  assert.ok(rows.every(({ inspection, health }) => inspection.state === 'terminal' && health.state === 'succeeded'));
  await t.diagnostic(JSON.stringify({ scenario: '2283 terminal jobs', elapsedMs, servicedBeforeFinish: serviced }));
  const progressed = serviced;
  await tick;
  assert.equal(progressed, true, 'a sweep must not monopolize the API loop until every historical job is read');
});

test('SQLite lock waiting in reconciliation does not delay an unrelated real HTTP request', async (t) => {
  const { service, path } = history(t, 1);
  const child = fork(new URL('./helpers/managed-job-lock-holder.mjs', import.meta.url), [path], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await once(child, 'message');
  const server = createServer((_req, res) => res.end('ready'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // The request is issued before reconciliation, so it is already waiting for
  // this same event loop when a synchronous SQLite busy wait would begin.
  const started = performance.now();
  const response = new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${server.address().port}`, (res) => {
      res.resume();
      res.once('end', () => resolve(performance.now() - started));
    }).once('error', reject);
  });
  const work = service.reconcile([], 100);
  const healthMs = await response;
  const rows = await work;
  await t.diagnostic(JSON.stringify({ scenario: 'held SQLite write lock', healthMs, rows: rows.length }));
  assert.equal(rows.length, 1);
  assert.ok(healthMs < 200, `unrelated HTTP must remain responsive during lock contention: ${healthMs}ms`);
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
});

test('a reconciliation scope reuses its database and releases it even on failure', async (t) => {
  const { service } = history(t, 1);
  const job = service.list()[0];
  let connection;
  await assert.rejects(
    withSupervisorStores(async () => {
      connection = openSupervisorStore(job);
      assert.equal(openSupervisorStore(job), connection);
      closeSupervisorStore(connection);
      assert.equal(connection.open, true, 'a nested read cannot close the round-owned connection');
      throw new Error('injected reconciliation failure');
    }),
    /injected reconciliation failure/,
  );
  assert.equal(connection.open, false);
  const reopened = openSupervisorStore(job);
  try {
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM managed_jobs').get().n, 1);
  } finally {
    reopened.close();
  }
});
