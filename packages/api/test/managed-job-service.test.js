import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { listManagedCommandExecutions } from '../dist/domains/cats/services/agents/invocation/active-execution-service.js';
import {
  rawDurableGateRecord,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { ManagedRunner } from '../dist/infrastructure/managed-runner.js';
import { buildManagedRunnerEnvironment } from '../dist/infrastructure/managed-runner-environment.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { isCancelableHoldBallTask } from '../dist/routes/hold-ball-cancel.js';
import { tryAutoCancelPendingHolds } from '../dist/routes/messages.js';
import { readUnixProcessSnapshotSync, sameUnixProcess } from '../dist/utils/cli-process-ownership.js';

const principal = { userId: 'user-1', threadId: 'thread-1', catId: 'gemini38' };
const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
const node = (code) => `${quote(process.execPath)} -e ${quote(code)}`;

function isLiveDescendant(identity) {
  const snapshot = readUnixProcessSnapshotSync({ pids: [identity.pid] });
  assert.notEqual(snapshot, null, 'process identity observation must succeed');
  if (!sameUnixProcess(identity, snapshot.get(identity.pid))) return false;
  const status = spawnSync('/bin/ps', ['-p', String(identity.pid), '-o', 'stat='], { encoding: 'utf8' });
  if (status.status === 1 && !status.stdout.trim()) return false;
  assert.equal(status.status, 0, 'process state observation must succeed');
  // A killed child may keep its birth identity until its parent reaps it.
  // Z has no executing process or effects; it is not a surviving detached job.
  return !status.stdout.trim().startsWith('Z');
}

async function until(check, label, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${label}`);
}

function fixture(t, budget = 4) {
  const root = mkdtempSync(join(tmpdir(), 'managed-job-test-'));
  const previous = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  const service = new ManagedJobService(root, budget);
  t.after(async () => {
    for (const job of service.list()) {
      service.cancel(job.definition.principal, job.jobId);
    }
    await until(async () => {
      await service.reconcile();
      return service
        .list()
        .every((job) =>
          ['succeeded', 'failed', 'lost', 'cancelled', 'timed_out'].includes(
            service.get(job.definition.principal, job.jobId).state,
          ),
        );
    }, 'fixture jobs settled');
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const submit = (command, key = 'command', extra = {}) =>
    service.submit(principal, {
      command,
      cwd: root,
      originTaskId: `hold-ball-${key}`,
      originInvocationId: 'invocation-1',
      idempotencyKey: key,
      executionSlaMs: 5000,
      wakeTarget: principal,
      ...extra,
    });
  return { root, service, submit };
}

test('submission is durable, principal scoped, deduplicated and admits before any effect', async (t) => {
  const { root, service, submit } = fixture(t);
  const marker = join(root, 'effect');
  const command = node(`require('fs').appendFileSync(${JSON.stringify(marker)}, 'once'); console.log('finished')`);
  const [job, duplicate] = await Promise.all([submit(command), submit(command)]);
  assert.equal(job.jobId, duplicate.jobId);
  assert.equal(service.list().length, 1);
  assert.equal(existsSync(marker), false);
  const restored = new ManagedJobService(root);
  assert.equal(restored.get(principal, job.jobId).state, 'queued');
  assert.throws(() => restored.get({ ...principal, catId: 'another-cat' }, job.jobId), /not_found/);
  await assert.rejects(restored.reconcileJob({ ...principal, catId: 'another-cat' }, job.jobId), /not_found/);
  assert.equal((await restored.reconcileJob(principal, job.jobId)).inspection.state, 'pending');
  assert.throws(() => restored.cancel({ ...principal, userId: 'another-user' }, job.jobId), /not_found/);
  assert.throws(() => restored.tail({ ...principal, threadId: 'another-thread' }, job.jobId), /not_found/);
  assert.throws(() => restored.start(principal, job.jobId, new ManagedRunner()), /not_admitted/);
  assert.equal(existsSync(marker), false);
  await assert.rejects(submit(node('console.log(2)')), /idempotency_conflict/);
  restored.admit(principal, job.jobId, 'visible-queued-message');
  const { admission, completion } = restored.start(principal, job.jobId, new ManagedRunner());
  assert.equal((await admission).spawned, true);
  await completion;
  assert.equal(restored.get(principal, job.jobId).state, 'succeeded');
  assert.equal(readFileSync(marker, 'utf8'), 'once');
  assert.match(restored.tail(principal, job.jobId), /finished/);
  assert.equal(restored.tail(principal, job.jobId, 4).length, 4);
  const transitions = restored.transitions(principal, job.jobId);
  assert.equal(transitions.filter((entry) => entry.state === 'terminal').length, 1);
  assert.deepEqual(
    transitions.map((entry) => entry.revision),
    transitions.map((_, index) => index + 1),
  );
  assert.equal(
    writeDurableGateRecord(job, { ...rawDurableGateRecord(job), state: 'running', updatedAt: Date.now() }),
    false,
  );
  assert.equal(restored.get(principal, job.jobId).state, 'succeeded');
});

test('ordinary commands have a principal budget separate from the hold quota and protected effects are denied', async (t) => {
  const { service, submit } = fixture(t, 1);
  const job = await submit(node('console.log(1)'));
  await assert.rejects(submit(node('console.log(2)'), 'second'), /budget_exhausted/);
  service.cancel(principal, job.jobId);
  await assert.rejects(submit('redis-cli -p 6399 FLUSHALL', 'forbidden'), /effect_denied/);
  const previous = process.env.CAT_CAFE_MANAGED_JOB_ID;
  process.env.CAT_CAFE_MANAGED_JOB_ID = job.jobId;
  try {
    await assert.rejects(submit(node('console.log(3)'), 'nested'), /nested_managed_job/);
  } finally {
    if (previous === undefined) delete process.env.CAT_CAFE_MANAGED_JOB_ID;
    else process.env.CAT_CAFE_MANAGED_JOB_ID = previous;
  }
});

test('a mismatched wake principal is refused before it can persist an unrunnable job', async (t) => {
  const { service, submit } = fixture(t);
  await assert.rejects(
    submit('printf never', 'mismatched', { wakeTarget: { ...principal, userId: 'other-owner' } }),
    /managed_job_wake_principal_mismatch/,
  );
  assert.equal(service.list().length, 0);
});

test('command environment never inherits callback credentials or provider tree ownership', () => {
  const env = buildManagedRunnerEnvironment({
    PATH: process.env.PATH,
    CAT_CAFE_CALLBACK_TOKEN: 'secret',
    CAT_CAFE_INVOCATION_ID: 'old-invocation',
    CAT_CAFE_CREDENTIAL_FILE: '/private/credentials',
    CAT_CAFE_SESSION_CREDENTIAL_FILE: '/private/session',
    CAT_CAFE_CLI_OWNER_TOKEN: 'provider-owner',
  });
  assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
  assert.equal(env.CAT_CAFE_INVOCATION_ID, undefined);
  assert.equal(env.CAT_CAFE_CREDENTIAL_FILE, undefined);
});

test('one owner budget spans threads while idempotency and reads remain thread scoped', async (t) => {
  const { root, service, submit } = fixture(t, 1);
  await submit(node('console.log(1)'));
  const otherThread = { ...principal, threadId: 'thread-2' };
  await assert.rejects(
    service.submit(otherThread, {
      command: node('console.log(2)'),
      cwd: root,
      originTaskId: 'hold-ball-another-thread',
      originInvocationId: 'invocation-2',
      idempotencyKey: 'same-key',
      executionSlaMs: 1000,
      wakeTarget: otherThread,
    }),
    /budget_exhausted/,
  );
});

test('consuming or force-resetting the wake carrier does not hide a live job or remove its cancel affordance', async (t) => {
  const { service, submit } = fixture(t);
  const job = await submit(node('console.log(1)'));
  service.admit(principal, job.jobId, 'visible-message');
  const task = {
    id: job.originTaskId,
    templateId: 'reminder',
    deliveryThreadId: principal.threadId,
    createdBy: `hold-ball:${principal.catId}`,
    enabled: false,
    params: {
      triggerUserId: principal.userId,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'fired',
        createdBy: `hold-ball:${principal.catId}`,
        managedCommand: {
          state: 'consumed',
          jobId: job.jobId,
          command: job.definition.command,
          startedAt: 100,
          carrierTerminalReason: 'force_reset',
        },
      },
    },
  };
  assert.equal(isCancelableHoldBallTask(task), true);
  const active = listManagedCommandExecutions([]);
  assert.ok(active.some((entry) => entry.taskId === job.originTaskId));
  service.cancel(principal, job.jobId);
  assert.equal(isCancelableHoldBallTask(task), false);
  assert.equal(
    listManagedCommandExecutions([]).some((entry) => entry.taskId === job.originTaskId),
    false,
  );
});

test('raw signal, stderr and durable bounded log provenance survive a worker exit', async (t) => {
  const { service, submit } = fixture(t);
  const job = await submit(
    `exec ${node("console.error('original dependency failure'); process.kill(process.pid, 'SIGTERM')")}`,
  );
  service.admit(principal, job.jobId, 'visible-failure');
  const run = service.start(principal, job.jobId, new ManagedRunner());
  await run.admission;
  await run.completion;
  const result = service.get(principal, job.jobId);
  assert.equal(result.state, 'failed');
  assert.equal(result.result.signal, 'SIGTERM');
  assert.equal(result.result.terminationReason, 'command_exit');
  assert.match(result.result.tailOutput, /original dependency failure/);
  assert.match(result.result.log.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.result.log.bytes > 0 && result.result.log.bytes <= 10 * 1024 * 1024);
});

for (const exitCode of [0, 7]) {
  test(`observed command exit ${exitCode} survives an unproven cleanup and worker restart`, async (t) => {
    const { root, service, submit } = fixture(t);
    const marker = join(root, 'observed-effect');
    const job = await submit(
      node(
        `require('fs').appendFileSync(${JSON.stringify(marker)}, 'once'); console.log('observed'); process.exit(${exitCode})`,
      ),
    );
    service.admit(principal, job.jobId, 'visible-before-observation');
    const workerCode = `
      const { job } = JSON.parse(process.env.JOB_TEST_INPUT);
      const { recordDurableManagedGateProcess } = await import(process.env.JOB_STORE_MODULE);
      const { readUnixProcessSnapshotSync } = await import(process.env.JOB_PROCESS_MODULE);
      const { runManagedCommandWorker } = await import(process.env.JOB_WORKER_MODULE);
      const { cleanupAndDrainDurableManagedGateAttempt } = await import(process.env.JOB_CHILD_MODULE);
      const { openDurableManagedRunnerLog } = await import(process.env.JOB_LOG_MODULE);
      if (!recordDurableManagedGateProcess(job, readUnixProcessSnapshotSync({ pids: [process.pid] }).get(process.pid))) throw new Error('birth refused');
      const log = openDurableManagedRunnerLog(job.logPath);
      process.exitCode = await runManagedCommandWorker({
        job, environment: process.env, capture: log.capture, finishLog: log.finish, cancelled: () => false,
        cleanupAttempt: async (...args) => {
          const drained = await cleanupAndDrainDurableManagedGateAttempt(...args);
          if (!drained.proven) throw new Error('fixture cleanup itself failed');
          return { ...drained, proven: false, processCleanupProven: false };
        },
      });
    `;
    const module = (path) => new URL(`../dist/${path}.js`, import.meta.url).href;
    const worker = spawn(process.execPath, ['--input-type=module', '-e', workerCode], {
      env: {
        ...buildManagedRunnerEnvironment(process.env),
        CAT_CAFE_DATA_DIR: root,
        JOB_TEST_INPUT: JSON.stringify({ job }),
        JOB_STORE_MODULE: module('domains/managed-job/durable-managed-gate-job-store'),
        JOB_PROCESS_MODULE: module('utils/cli-process-ownership'),
        JOB_WORKER_MODULE: module('infrastructure/managed-runner-command-worker'),
        JOB_CHILD_MODULE: module('infrastructure/managed-runner-durable-child'),
        JOB_LOG_MODULE: module('infrastructure/managed-runner-durable-log'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    worker.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const status = await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', resolve);
    });
    assert.equal(status, 70, stderr);
    assert.equal(service.get(principal, job.jobId).state, 'running', 'unknown cleanup cannot become terminal');
    const restored = new ManagedJobService(root);
    await restored.reconcile();
    const recovered = restored.get(principal, job.jobId);
    assert.equal(
      recovered.state,
      exitCode === 0 ? 'succeeded' : 'failed',
      'known command result must survive deferred cleanup',
    );
    assert.equal(recovered.result.exitCode, exitCode);
    assert.equal(recovered.result.terminationReason, 'command_exit');
    assert.match(recovered.result.tailOutput, /observed/);
    assert.equal(readFileSync(marker, 'utf8'), 'once');
    assert.equal(restored.transitions(principal, job.jobId).filter((entry) => entry.state === 'terminal').length, 1);
  });
}

test('a long command renews its worker lease without inventing another state transition', async (t) => {
  const { service, submit } = fixture(t);
  const job = await submit(node('setTimeout(() => console.log("heartbeat survived"), 5600)'), 'heartbeat', {
    executionSlaMs: 8000,
  });
  service.admit(principal, job.jobId, 'visible-heartbeat');
  const run = service.start(principal, job.jobId, new ManagedRunner());
  await run.admission;
  await run.completion;
  assert.equal(service.get(principal, job.jobId).state, 'succeeded');
  assert.equal(
    service.transitions(principal, job.jobId).length,
    7,
    'submit, visible admission, worker birth, attempt, observed exit, proven cleanup, terminal; no heartbeat transition',
  );
  const history = service.transitions(principal, job.jobId);
  assert.equal(history.at(-2).cleanupProven, true, 'cleanup proof must be durable before terminal publication');
  assert.notEqual(history.at(-2).state, 'terminal');
});

const ownerCode = `
const { ManagedJobService } = await import(process.env.JOB_SERVICE_MODULE);
const { ManagedRunner } = await import(process.env.JOB_RUNNER_MODULE);
const { principal, jobId } = JSON.parse(process.env.JOB_TEST_INPUT);
const service = new ManagedJobService();
const { admission } = service.start(principal, jobId, new ManagedRunner());
process.stdout.write('JOB_TEST_ADMISSION:' + JSON.stringify(await admission) + '\\n');
setInterval(() => {}, 1000);
`;

async function startOwner(t, root, jobId) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', ownerCode], {
    env: {
      ...process.env,
      CAT_CAFE_DATA_DIR: root,
      JOB_SERVICE_MODULE: new URL('../dist/domains/managed-job/ManagedJobService.js', import.meta.url).href,
      JOB_RUNNER_MODULE: new URL('../dist/infrastructure/managed-runner.js', import.meta.url).href,
      JOB_TEST_INPUT: JSON.stringify({ principal, jobId }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString();
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  await until(() => {
    if (child.exitCode !== null) throw new Error(`owner exited ${child.exitCode}: ${errors}`);
    return out.split('\n').some((line) => line.startsWith('JOB_TEST_ADMISSION:'));
  }, 'worker admitted');
  const receipt = out.split('\n').find((line) => line.startsWith('JOB_TEST_ADMISSION:'));
  assert.equal(JSON.parse(receipt.slice('JOB_TEST_ADMISSION:'.length)).spawned, true, receipt);
  return child;
}

test('API death does not stop the job; a new service observes its independently persisted terminal', async (t) => {
  const { root, service, submit } = fixture(t);
  const marker = join(root, 'complete');
  const job = await submit(
    node(
      `setTimeout(() => {require('fs').writeFileSync(${JSON.stringify(marker)}, 'once');console.log('survived API')}, 600)`,
    ),
  );
  service.admit(principal, job.jobId, 'visible-message');
  const owner = await startOwner(t, root, job.jobId);
  await until(() => service.get(principal, job.jobId).state === 'running', 'worker registered');
  owner.kill('SIGKILL');
  const restored = new ManagedJobService(root);
  await until(() => restored.get(principal, job.jobId).state === 'succeeded', 'independent terminal');
  assert.equal(readFileSync(marker, 'utf8'), 'once');
  assert.match(restored.tail(principal, job.jobId), /survived API/);
  assert.equal(restored.transitions(principal, job.jobId).filter((entry) => entry.state === 'terminal').length, 1);
});

test('after worker death recovery cleans its exact descendants, records lost and never replays', async (t) => {
  const { root, service, submit } = fixture(t);
  const marker = join(root, 'starts');
  const job = await submit(
    node(`require('fs').appendFileSync(${JSON.stringify(marker)}, 'once');setInterval(() => {}, 1000)`),
  );
  service.admit(principal, job.jobId, 'visible-message');
  const owner = await startOwner(t, root, job.jobId);
  await until(() => existsSync(marker), 'command started');
  const worker = service.get(principal, job.jobId).ownerIdentity;
  assert.ok(sameUnixProcess(worker, readUnixProcessSnapshotSync({ pids: [worker.pid] }).get(worker.pid)));
  process.kill(worker.pid, 'SIGKILL');
  owner.kill('SIGKILL');
  const restored = new ManagedJobService(root);
  await until(async () => {
    await restored.reconcile();
    return restored.get(principal, job.jobId).state === 'lost';
  }, 'lost after cleanup');
  assert.equal(readFileSync(marker, 'utf8'), 'once');
  assert.throws(() => restored.start(principal, job.jobId, new ManagedRunner()), /not_admitted/);
});

test('timeout and explicit cancellation survive reconstruction and retain exact terminal cause', async (t) => {
  const { root, service, submit } = fixture(t);
  for (const cause of ['timed_out', 'cancelled']) {
    const job = await submit(node('setInterval(() => {}, 1000)'), cause, {
      executionSlaMs: cause === 'timed_out' ? 1000 : 5000,
    });
    service.admit(principal, job.jobId, `visible-${cause}`);
    const run = service.start(principal, job.jobId, new ManagedRunner());
    await run.admission;
    const restored = new ManagedJobService(root);
    await until(() => restored.get(principal, job.jobId).state === 'running', 'running before cancellation');
    if (cause === 'cancelled') restored.cancel(principal, job.jobId);
    await run.completion;
    assert.equal(restored.get(principal, job.jobId).state, cause);
    assert.equal(restored.transitions(principal, job.jobId).filter((entry) => entry.state === 'terminal').length, 1);
  }
});

test(
  '20 fault cycles: one terminal delivery, no user-message cancellation, duplicate effect or unaccounted descendant',
  { timeout: 90_000 },
  async (t) => {
    const { root, service, submit } = fixture(t);
    const db = new Database(join(root, 'scheduler.sqlite'));
    applyMigrations(db);
    const tasks = new DynamicTaskStore(db);
    const messages = new Map();
    const deliveries = new Map();
    let failNextAppend = false;
    const deps = {
      dynamicTaskStore: tasks,
      taskRunner: { unregister() {} },
      socketManager: { broadcastToRoom() {} },
      messageStore: {
        getByIdempotencyKey(_user, _thread, key) {
          return messages.get(key) ?? null;
        },
        async append(input) {
          if (failNextAppend) {
            failNextAppend = false;
            throw new Error('injected transient message-store outage');
          }
          const prior = messages.get(input.idempotencyKey);
          if (prior) return prior;
          const stored = { ...input, id: `wake-${messages.size}` };
          messages.set(input.idempotencyKey, stored);
          return stored;
        },
      },
      invocationRecordStore: {
        getByIdempotencyKey() {
          return null;
        },
      },
      getEventCarrier: ({ messageId }) =>
        deliveries.has(messageId) ? { state: 'handled', invocationId: `delivered-${messageId}` } : { state: 'missing' },
      async admitWake(input) {
        assert.deepEqual({ threadId: input.threadId, catId: input.catId, userId: input.userId }, principal);
        const prior = messages.get(input.message.idempotencyKey);
        const stored = prior ?? (await deps.messageStore.append(input.message));
        if (!prior) deliveries.set(stored.id, 1);
        return { messageId: stored.id };
      },
    };
    let completed = 0;
    try {
      for (let index = 0; index < 20; index++) {
        const key = `fault-${index}`;
        const marker = join(root, `${key}.starts`);
        const pidPath = join(root, `${key}.child`);
        const releasePath = join(root, `${key}.release`);
        const command = node(`const fs = require('fs');
        const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref();
        fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); fs.appendFileSync(${JSON.stringify(marker)}, 'once');
        const ready = setInterval(() => { if (!fs.existsSync(${JSON.stringify(releasePath)})) return; clearInterval(ready);
          setTimeout(() => { console.log(${JSON.stringify(key)}); process.exit(${index % 3 === 2 ? 7 : 0}); }, ${index % 3 === 1 ? 20_000 : 600});
        }, 10);`);
        const job = await submit(command, key, { executionSlaMs: 30_000 });
        const now = Date.now();
        tasks.insert({
          id: job.originTaskId,
          templateId: 'reminder',
          trigger: { type: 'once', fireAt: now + 60_000 },
          params: {
            targetCatId: principal.catId,
            triggerUserId: principal.userId,
            message: 'fallback',
            holdLifecycle: {
              mode: 'wake_when',
              status: 'active',
              createdBy: `hold-ball:${principal.catId}`,
              wakeAt: now + 60_000,
              managedCommand: { state: 'command_running', command, startedAt: now, jobId: job.jobId },
            },
          },
          display: { label: key, category: 'system', description: key },
          deliveryThreadId: principal.threadId,
          enabled: true,
          createdBy: `hold-ball:${principal.catId}`,
          createdAt: new Date(now).toISOString(),
        });
        service.admit(principal, job.jobId, `visible-${key}`);
        const owner = await startOwner(t, root, job.jobId);
        await until(() => existsSync(marker), 'fault command reached effect');
        const descendantPid = Number(readFileSync(pidPath, 'utf8'));
        const descendant = await until(
          () => readUnixProcessSnapshotSync({ pids: [descendantPid] })?.get(descendantPid),
          'fixture descendant birth observation before releasing command',
        );
        tryAutoCancelPendingHolds(principal.threadId, deps);
        assert.equal(tasks.getById(job.originTaskId).enabled, true, 'a user message does not cancel execution');
        const worker = service.get(principal, job.jobId).ownerIdentity;
        if (index % 3 === 1) process.kill(worker.pid, 'SIGKILL');
        owner.kill('SIGKILL');
        writeFileSync(releasePath, 'owner death injected');
        failNextAppend = index % 4 === 0;
        await until(async () => {
          // Reconstruct the recovery consumer on EVERY attempt, including after a failed delivery.
          await new ManagedCommandWakeRecoverySweep(deps).runOnce();
          return tasks.getById(job.originTaskId).params.holdLifecycle.managedCommand.state === 'consumed';
        }, `fault ${index} terminal delivery`);
        await new ManagedCommandWakeRecoverySweep(deps).runOnce();
        const state = service.get(principal, job.jobId).state;
        assert.equal(state, index % 3 === 1 ? 'lost' : index % 3 === 2 ? 'failed' : 'succeeded');
        assert.equal(readFileSync(marker, 'utf8'), 'once', 'no replay of the side effect');
        assert.equal(isLiveDescendant(descendant), false, 'no unaccounted detached descendant');
        assert.ok(messages.has(`hold-ball-completion:${job.originTaskId}`));
        completed++;
      }
      assert.equal(completed, 20);
      assert.equal(messages.size, 20);
      assert.equal(deliveries.size, 20);
      assert.ok([...deliveries.values()].every((count) => count === 1));
      t.diagnostic(
        '20/20 terminal deliveries; 0 user-message cancellations; 0 duplicate effects; 0 unaccounted descendants',
      );
    } finally {
      db.close();
    }
  },
);

test('explicit retry creates a new fenced epoch with immutable parent and principal isolation', async (t) => {
  const { service, submit } = fixture(t);
  const command = node('console.log("manual retry")');
  const first = await submit(command, 'original');
  await assert.rejects(submit(command, 'too-early', { retryOfJobId: first.jobId }), /retry_requires_terminal/);
  service.cancel(principal, first.jobId);
  const before = service.get(principal, first.jobId);
  const [next, replay] = await Promise.all([
    submit(command, 'explicit-retry', { retryOfJobId: first.jobId }),
    submit(command, 'explicit-retry', { retryOfJobId: first.jobId }),
  ]);
  assert.equal(next.jobId, replay.jobId);
  assert.notEqual(next.jobId, first.jobId);
  assert.equal(next.definition.retryEpoch, 1);
  assert.equal(next.definition.retryOfJobId, first.jobId);
  assert.equal(service.get(principal, next.jobId).retryEpoch, 1);
  assert.equal(service.get(principal, first.jobId).state, before.state);
  assert.equal(service.list().length, 2);
  await assert.rejects(submit(command, 'explicit-retry'), /idempotency_conflict/);
  await assert.rejects(
    service.submit(
      { ...principal, catId: 'another-cat' },
      {
        command,
        cwd: next.definition.cwd,
        originTaskId: 'other',
        originInvocationId: 'other',
        idempotencyKey: 'other',
        executionSlaMs: 5000,
        wakeTarget: principal,
        retryOfJobId: first.jobId,
      },
    ),
    /not_found/,
  );
});
