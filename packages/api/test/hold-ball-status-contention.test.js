import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import {
  rawDurableGateRecord,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

async function fixture(t, { retired = false, admitted = true, state = 'queued', mismatch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hold-status-lock-'));
  const previousRoot = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  const cleanup = [];
  const app = Fastify();
  t.after(async () => {
    for (const stop of cleanup) await stop();
    await app.close();
    if (previousRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });
  const registry = new InvocationRegistry();
  const threadStore = new ThreadStore();
  const thread = await threadStore.create('owner', 'status contention');
  const principal = { userId: 'owner', catId: 'codex', threadId: thread.id };
  const task = {
    id: 'hold-ball-status-lock',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: Date.now() + 60000 },
    params: {
      triggerUserId: principal.userId,
      holdLifecycle: {
        mode: 'wake_when',
        status: retired ? 'cancelled_by_user' : 'active',
        createdBy: 'hold-ball:codex',
      },
    },
    display: { label: 'status test', category: 'system', description: 'private fixture' },
    deliveryThreadId: thread.id,
    enabled: !retired,
    createdBy: 'hold-ball:codex',
    createdAt: new Date().toISOString(),
  };
  const tasks = [task];
  const dynamicTaskStore = {
    getById: (id) => tasks.find((item) => item.id === id) ?? null,
    getAll: () => [...tasks],
    findByDeliveryThreadAndCreatedBy: (threadId, createdBy) =>
      tasks.filter((item) => item.deliveryThreadId === threadId && item.createdBy === createdBy),
  };
  const messageStore = {
    async append(message) {
      return { id: 'message', ...message };
    },
    async getMessagesForThread() {
      return [];
    },
  };
  const socketManager = {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    getMessages() {
      return [];
    },
  };
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    socketManager,
    threadStore,
    evidenceStore: {
      async store() {},
      async search() {
        return [];
      },
    },
    markerQueue: { enqueue() {} },
    reflectionService: { async run() {} },
    holdBallDeps: {
      registry,
      ownerUserId: principal.userId,
      threadStore,
      dynamicTaskStore,
      messageStore,
      socketManager,
      taskRunner: { registerDynamic() {}, unregister() {} },
      templateRegistry: {
        get() {
          return undefined;
        },
      },
      scheduleMutationAuditStore: {},
    },
  });
  app.get('/status-probe-health', async () => ({ ready: true }));
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const service = new ManagedJobService(root);
  const job = await service.submit(principal, {
    command: 'printf never-started',
    cwd: root,
    originInvocationId: 'fixture-invocation',
    originTaskId: mismatch ? 'hold-ball-other' : task.id,
    idempotencyKey: 'status-test',
    executionSlaMs: 10000,
    wakeTarget: principal,
  });
  if (admitted) service.admit(principal, job.jobId, 'visible-admission');
  if (state !== 'queued')
    assert.equal(
      writeDurableGateRecord(job, {
        ...rawDurableGateRecord(job),
        state,
        ...(state === 'terminal'
          ? { terminalStatus: 'failed', cleanupProven: true, result: { exitCode: 7, timedOut: false, durationMs: 10 } }
          : {}),
      }),
      true,
    );
  task.params.holdLifecycle.managedCommand = {
    state: 'command_running',
    command: 'printf never-started',
    startedAt: Date.now(),
    jobId: job.jobId,
  };
  const before = rawDurableGateRecord(job);
  const headers = async (userId = 'owner', catId = 'codex', threadId = thread.id) => {
    const auth = await registry.create(userId, catId, threadId);
    return { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  };
  const ownerHeaders = await headers();
  return {
    task,
    tasks,
    job,
    service,
    principal,
    headers,
    url,
    async read(path, suppliedHeaders = ownerHeaders) {
      const response = await fetch(`${url}${path}`, { headers: suppliedHeaders });
      return { statusCode: response.status, body: await response.json() };
    },
    unchanged() {
      assert.deepEqual(rawDurableGateRecord(job), before, 'status must not change the job or its admission');
      assert.equal(service.list().length, 1, 'status cannot admit another execution');
    },
    async lock(durationMs) {
      const child = fork(
        new URL('./helpers/managed-job-lock-holder.mjs', import.meta.url),
        [join(root, 'managed-jobs/supervisor.sqlite'), String(durationMs)],
        { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      const closed = once(child, 'close');
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-2000);
      });
      const release = async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      };
      cleanup.push(release);
      await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(5000) }),
        closed.then(([code, signal]) => {
          throw new Error(`lock holder exited: ${code}/${signal}: ${stderr}`);
        }),
      ]);
      return { closed, release };
    },
  };
}

for (const retired of [false, true]) {
  for (const endpoint of ['status', 'current']) {
    for (const lockMs of [900, 6000]) {
      test(
        `${endpoint}: ${retired ? 'retired' : 'pending'} managed hold survives ${lockMs}ms lock without blocking HTTP`,
        { timeout: 18000 },
        async (t) => {
          const f = await fixture(t, { retired });
          const lock = await f.lock(lockMs);
          const path =
            endpoint === 'current'
              ? '/api/callbacks/hold-ball/current'
              : `/api/callbacks/hold-ball/${f.task.id}/status`;
          const started = performance.now();
          const tick = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
          const result = await f.read(path);
          const timerMs = await tick;
          await lock.release();
          t.diagnostic(JSON.stringify({ endpoint, retired, lockMs, timerMs, statusCode: result.statusCode }));
          assert.equal(result.statusCode, 200, JSON.stringify(result.body));
          assert.ok(timerMs < 250, `unrelated API work waited ${timerMs}ms`);
          assert.equal(result.body.cancelable, true);
          assert.equal(result.body.job.jobId, f.job.jobId);
          if (endpoint === 'status') assert.equal(result.body.access.canCancel, true);
          else assert.equal(result.body.hasActiveHold, !retired);
          f.unchanged();
        },
      );
    }
  }
}

test('both status fields use the same admitted-job state and exact task association', async (t) => {
  for (const options of [
    { admitted: false },
    { state: 'terminal' },
    { state: 'waiting' },
    { state: 'cancelling' },
    { mismatch: true },
  ]) {
    await t.test(JSON.stringify(options), async (t) => {
      const f = await fixture(t, options);
      const result = await f.read(`/api/callbacks/hold-ball/${f.task.id}/status`);
      assert.equal(result.statusCode, 200, JSON.stringify(result.body));
      const expected = options.state === 'waiting' || options.state === 'cancelling';
      assert.equal(result.body.cancelable, expected);
      assert.equal(result.body.access.canCancel, expected);
      if (options.mismatch) assert.equal(result.body.job, undefined, 'another task cannot supply this status view');
      f.unchanged();
    });
  }
});

test('summary-only status does not read a private managed job even while its database is locked', async (t) => {
  const f = await fixture(t);
  const collaborator = await f.headers('collaborator');
  const lock = await f.lock(6000);
  const started = performance.now();
  const result = await f.read(`/api/callbacks/hold-ball/${f.task.id}/status`, collaborator);
  assert.ok(performance.now() - started < 250);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.access.lifecycleVisibility, 'summary');
  assert.equal(result.body.cancelable, false);
  assert.equal(result.body.job, undefined);
  f.task.enabled = false;
  f.task.params.holdLifecycle.status = 'cancelled_by_user';
  const currentStarted = performance.now();
  const current = await f.read('/api/callbacks/hold-ball/current', collaborator);
  assert.ok(performance.now() - currentStarted < 250, 'retired selection must authorize before a private read');
  assert.equal(current.statusCode, 200);
  assert.equal(current.body.hasActiveHold, false);
  await lock.release();
  f.unchanged();
});

test('retired selection skips a finished execution and returns the next original admitted job', async (t) => {
  const f = await fixture(t, { retired: true, state: 'terminal' });
  const nextTask = structuredClone(f.task);
  nextTask.id = 'hold-ball-next-original';
  const next = await f.service.submit(f.principal, {
    command: 'printf never-started',
    cwd: f.job.definition.cwd,
    originInvocationId: 'fixture-invocation',
    originTaskId: nextTask.id,
    idempotencyKey: 'next-original',
    executionSlaMs: 10000,
    wakeTarget: f.principal,
  });
  f.service.admit(f.principal, next.jobId, 'next-visible-admission');
  nextTask.params.holdLifecycle.managedCommand.jobId = next.jobId;
  f.tasks.push(nextTask);
  const response = await f.read('/api/callbacks/hold-ball/current');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.taskId, nextTask.id);
  assert.equal(response.body.job.jobId, next.jobId);
  assert.equal(response.body.hasActiveHold, false);
  assert.equal(response.body.cancelable, true);
  assert.equal(f.service.get(f.principal, f.job.jobId).state, 'failed');
  assert.equal(f.service.list().length, 2);
});

test(
  'operator status uses the same nonblocking snapshot for cancellation and output',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const lock = await f.lock(900);
    const started = performance.now();
    const tick = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
    const response = await f.read(`/api/callbacks/hold-ball/${f.task.id}/status?tailBytes=100`, {
      'x-cat-cafe-user': 'owner',
    });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.ok((await tick) < 250);
    assert.equal(response.body.access.role, 'operator');
    assert.equal(response.body.cancelable, true);
    assert.equal(response.body.access.canCancel, true);
    assert.equal(response.body.job.tail, '');
    await lock.release();
    f.unchanged();
  },
);
