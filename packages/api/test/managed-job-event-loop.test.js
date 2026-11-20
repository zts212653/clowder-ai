import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createActiveExecutionService,
  listManagedCommandExecutions,
} from '../dist/domains/cats/services/agents/invocation/active-execution-service.js';
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
  const insert =
    db.prepare(`INSERT INTO managed_jobs(job_id,principal_key,idempotency_key,state,revision,record_json,recovery_json)
    VALUES (?, ?, ?, ?, ?, ?, '{"version":1,"attempts":0,"nextAttemptAt":null}')`);
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

test('due reconciliation excludes settled history while the API event loop remains responsive', async (t) => {
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
  assert.equal(rows.length, 0, 'settled history cannot become periodic recovery work');
  assert.equal(service.list().length, 2283, 'the explicit historical read still retains every record');
  await t.diagnostic(JSON.stringify({ scenario: '2283 terminal jobs', elapsedMs, servicedBeforeFinish: serviced }));
  const progressed = serviced;
  await tick;
  assert.equal(progressed, true, 'a sweep must not monopolize the API loop until every historical job is read');
});

test(
  'SQLite lock waiting in reconciliation does not delay an unrelated real HTTP request',
  { timeout: 15_000 },
  async (t) => {
    const { service, path } = history(t, 1);
    const child = fork(new URL('./helpers/managed-job-lock-holder.mjs', import.meta.url), [path], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
    });
    let childError = '';
    child.stderr.on('data', (chunk) => {
      childError = `${childError}${chunk}`.slice(-2000);
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(5000) }),
      once(child, 'exit').then(([code, signal]) => {
        throw new Error(`lock fixture exited before ready: ${code}/${signal}: ${childError}`);
      }),
    ]);
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
    assert.equal(rows.length, 0, 'the locked historical row is retained, not selected for recovery');
    assert.ok(healthMs < 200, `unrelated HTTP must remain responsive during lock contention: ${healthMs}ms`);
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  },
);

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

test(
  'active command projection leaves HTTP responsive while its SQLite ledger is locked',
  { timeout: 15_000 },
  async (t) => {
    const { root, service, path } = history(t, 3);
    const previousRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(() => {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousRoot;
    });
    const job = service.list()[0];
    const database = openSupervisorStore(job);
    try {
      const record = JSON.parse(
        database.prepare('SELECT record_json FROM managed_jobs WHERE job_id = ?').get(job.jobId).record_json,
      );
      record.state = 'running';
      record.admissionMessageId = 'admitted-command';
      record.descriptor.definition = { principal: job.wakeTarget, command: 'node private-command.js' };
      database
        .prepare('UPDATE managed_jobs SET state = ?, record_json = ? WHERE job_id = ?')
        .run('running', JSON.stringify(record), job.jobId);
    } finally {
      database.close();
    }
    const releaseMarker = join(root, 'lock-released');
    const child = fork(
      new URL('./helpers/managed-job-lock-holder.mjs', import.meta.url),
      [path, '1200', releaseMarker],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        execArgv: [],
      },
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'close');
      }
    });
    await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const server = createServer((_req, response) => response.end(String(!existsSync(releaseMarker))));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const started = performance.now();
    const response = new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${server.address().port}`, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.once('end', () => resolve({ beforeRelease: body === 'true', elapsedMs: performance.now() - started }));
      }).once('error', reject);
    });
    const [health, executions] = await Promise.all([response, listManagedCommandExecutions([])]);
    await t.diagnostic(JSON.stringify({ scenario: 'active ledger lock', ...health, executions: executions.length }));
    assert.deepEqual(
      executions.map((entry) => entry.taskId),
      [job.originTaskId],
      'the admitted live job remains visible and terminal history stays excluded',
    );
    assert.equal(
      health.beforeRelease,
      true,
      'unrelated HTTP must finish while the independently held ledger lock is still present',
    );
  },
);

test('a failed active ledger read leaves owner truth incomplete instead of claiming no work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-active-error-'));
  const previousRoot = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'managed-jobs'));
  writeFileSync(join(root, 'managed-jobs/supervisor.sqlite'), 'not a SQLite database');
  const service = createActiveExecutionService({
    invocationTracker: { getActiveSlots: () => [], getUserId: () => null },
    dynamicTaskStore: { getAll: () => [] },
    log: { info() {}, warn() {} },
  });
  const snapshot = await service.buildSnapshot('owner');
  assert.equal(snapshot.complete, false);
  assert.equal(
    snapshot.ownerTruthComplete,
    false,
    'an asynchronous ledger failure cannot turn unknown occupancy into idle',
  );
});
