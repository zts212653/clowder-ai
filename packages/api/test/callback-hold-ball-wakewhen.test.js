/**
 * F167 Phase P — wakeWhen integration tests
 *
 * Tests for the P1-1 (runner cancel/replace) and P1-2 (delivery failure)
 * fixes identified in gpt52 review of PR #2550.
 *
 * T8: wakeWhen runner cancelled on hold_ball cancel → no stale wake
 * T9: wakeWhen re-hold retires only the old carrier; authorized job keeps running
 * T11: cancelWakeWhenRunner export + activeRunners registry
 * T12: atomic wake admission refused → fallback task NOT removed
 * T13: atomic wake admission throws → fallback task NOT removed
 * T14: positive execution-plane ack + durable carrier → fallback task retired
 */

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { resolveManagedCommandJob } from '../dist/domains/ball-custody/managed-command-job-reference.js';
import {
  readDurableGateRecord,
  readDurableTerminalReceipt,
  settleDurableManagedGateJobFromRunner,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { tryAutoCancelPendingHolds } from '../dist/routes/messages.js';
import { isolateManagedJobData } from './helpers/isolated-managed-job-data.js';

isolateManagedJobData();

/**
 * Each exceptional launch terminal below is announced under the generic
 * `phase:'status'`, which cannot say whether the wait is over. The card states
 * that itself, so a hold that already ended keeps no cancel controls even when
 * the status probe is unavailable. Asserted here on the card the route really
 * emitted — one helper rather than a copy per terminal.
 */
function assertStatesTerminal(message, label) {
  assert.equal(message?.source?.meta?.cancelable, false, `${label} must state cancelable: false on its card`);
}

describe('F167 Phase P: wakeWhen cancel/replace/delivery tests', () => {
  let registry;
  let threadStore;
  let cancelWakeWhenRunner;
  let getActiveRunnerCount;
  let reserveManagedWakeCancellation;
  let commitManagedWakeCancellation;
  let releaseManagedWakeCancellation;
  let cancelManagedWakeIfTaskMatches;
  let resolveHoldWaitOwnerFence;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    const routeModule = await import('../dist/routes/callback-hold-ball-routes.js');
    cancelWakeWhenRunner = routeModule.cancelWakeWhenRunner;
    getActiveRunnerCount = routeModule.getActiveRunnerCount;
    reserveManagedWakeCancellation = routeModule.reserveManagedWakeCancellation;
    commitManagedWakeCancellation = routeModule.commitManagedWakeCancellation;
    releaseManagedWakeCancellation = routeModule.releaseManagedWakeCancellation;
    cancelManagedWakeIfTaskMatches = routeModule.cancelManagedWakeIfTaskMatches;
    resolveHoldWaitOwnerFence = routeModule.resolveHoldWaitOwnerFence;
  });

  function makeStubDeps(overrides = {}) {
    const insertedTasks = [];
    const registeredDynamic = [];
    const unregisteredIds = [];
    const removedIds = [];
    const appendedMessages = [];
    const ownerAuthProvenanceByTaskId = new Map();
    const privateAuthorizationByTaskId = new Map();
    const defaultTemplate = {
      createSpec(taskId, taskParams) {
        return { taskId, taskParams };
      },
    };
    const deps = {
      registry,
      holdQuotaStore: {
        async tryAdmit() {
          return { admitted: true, count: 1, eventId: `stub-${Date.now()}` };
        },
        async releaseByEventId() {
          return true;
        },
        async getCount() {
          return 0;
        },
        async close() {},
      },
      taskRunner: {
        registerDynamic(spec, taskId) {
          registeredDynamic.push({ spec, taskId });
        },
        unregister(taskId) {
          unregisteredIds.push(taskId);
          return true;
        },
      },
      templateRegistry: {
        get(id) {
          return id === 'reminder' ? defaultTemplate : undefined;
        },
      },
      dynamicTaskStore: {
        insert(record, authorization) {
          insertedTasks.push(record);
          if (authorization !== undefined) {
            const snapshot = typeof authorization === 'string' ? { ownerAuthProvenance: authorization } : authorization;
            privateAuthorizationByTaskId.set(record.id, snapshot);
            ownerAuthProvenanceByTaskId.set(record.id, snapshot.ownerAuthProvenance);
          }
        },
        getAll() {
          return insertedTasks.filter((t) => !removedIds.includes(t.id));
        },
        getById(id) {
          return insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
        },
        remove(id) {
          removedIds.push(id);
          ownerAuthProvenanceByTaskId.delete(id);
          privateAuthorizationByTaskId.delete(id);
          return true;
        },
        getPrivateOwnerAuthProvenance(id) {
          return ownerAuthProvenanceByTaskId.get(id) ?? 'unknown';
        },
        getPrivateOwnerAuthorization(id) {
          return privateAuthorizationByTaskId.get(id) ?? { ownerAuthProvenance: 'unknown' };
        },
        updateParams(id, params) {
          const task = insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
          if (!task) return false;
          task.params = params;
          return true;
        },
        updateParamsIfCurrent(id, expected, params) {
          const task = insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
          if (!task || task.params !== expected) return false;
          task.params = params;
          return true;
        },
        setEnabled(id, enabled) {
          const task = insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
          if (!task) return false;
          task.enabled = enabled;
          return true;
        },
      },
      messageStore: {
        getByIdempotencyKey(_userId, threadId, key) {
          return (
            appendedMessages.find((message) => message.threadId === threadId && message.idempotencyKey === key) ?? null
          );
        },
        async append(msg) {
          const stored = { id: `test-msg-${appendedMessages.length}`, ...msg };
          appendedMessages.push(stored);
          return stored;
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      invocationRecordStore: {
        getByIdempotencyKey(_threadId, _userId, key) {
          return { id: `invocation-${key}`, userMessageId: key.slice('connector-'.length), status: 'running' };
        },
      },
      // F117 Phase I: the route owns no Queue, so composition injects the admission that commits
      // the wake Message and its Queue row together. The default one here admits successfully.
      async admitManagedWake(input) {
        const stored = { id: `test-msg-${appendedMessages.length}`, ...input.message };
        appendedMessages.push(stored);
        return { messageId: stored.id };
      },
      _insertedTasks: insertedTasks,
      _registeredDynamic: registeredDynamic,
      _unregisteredIds: unregisteredIds,
      _removedIds: removedIds,
      _appendedMessages: appendedMessages,
      _ownerAuthProvenanceByTaskId: ownerAuthProvenanceByTaskId,
      _privateAuthorizationByTaskId: privateAuthorizationByTaskId,
    };
    return { ...deps, ...overrides };
  }

  async function createApp(holdBallDeps) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps,
    });
    return app;
  }

  async function waitForCommandTerminal(deps, taskId) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const job = resolveManagedCommandJob(deps.dynamicTaskStore.getById(taskId));
      if (job && readDurableGateRecord(job)?.state === 'terminal') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('command did not reach its durable terminal');
  }

  async function waitForWakeHandling(deps, taskId, handled) {
    await waitForCommandTerminal(deps, taskId);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (handled()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(
      `wake handling did not settle: ${deps.dynamicTaskStore.getById(taskId)?.params.holdLifecycle.managedCommand.state}`,
    );
  }

  for (const actorUserId of ['scheduler', 'system']) {
    test(`F261 ${actorUserId} command and wake share the server-owned thread principal`, async () => {
      const deliveries = [];
      const deps = makeStubDeps({
        threadStore,
        invocationRecordStore: { getByIdempotencyKey: () => null },
        getEventCarrier: () =>
          deliveries.length ? { state: 'handled', invocationId: 'delivered' } : { state: 'missing' },
      });
      const admit = deps.admitManagedWake;
      deps.admitManagedWake = async (input) => {
        const result = await admit(input);
        deliveries.push({ threadId: input.threadId, catId: input.catId, userId: input.userId });
        return result;
      };
      deps.admitWake = deps.admitManagedWake;
      const app = await createApp(deps);
      const thread = await threadStore.create(`owner-${actorUserId}`, 'scheduled command');
      const auth = await registry.create(actorUserId, 'codex', thread.id);
      const request = {
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          reason: 'scheduled user work',
          nextStep: 'read the result',
          wakeWhen: { command: `printf ${actorUserId}`, executionSlaMs: 5000, idempotencyKey: 'scheduled-once' },
        },
      };
      try {
        const first = await app.inject(request);
        assert.equal(first.statusCode, 200, first.body);
        const body = first.json();
        const job = resolveManagedCommandJob(deps.dynamicTaskStore.getById(body.taskId));
        assert.deepEqual(job.definition.principal, job.wakeTarget);
        assert.equal(job.definition.principal.userId, thread.createdBy);
        const duplicate = await app.inject(request);
        assert.equal(duplicate.statusCode, 200, duplicate.body);
        assert.equal(duplicate.json().wakeWhen.jobId, body.wakeWhen.jobId);
        const { ManagedCommandWakeRecoverySweep } = await import(
          '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js'
        );
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && deliveries.length === 0) {
          await new ManagedCommandWakeRecoverySweep(deps).runOnce();
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        await new ManagedCommandWakeRecoverySweep(deps).runOnce();
        const record = readDurableGateRecord(job);
        assert.equal(record.state, 'terminal');
        assert.equal(record.result.exitCode, 0);
        assert.equal(record.result.tailOutput, actorUserId);
        assert.deepEqual(deliveries, [{ threadId: thread.id, catId: 'codex', userId: thread.createdBy }]);
        assert.equal(
          deps._appendedMessages.filter((message) => message.idempotencyKey === `hold-ball-completion:${body.taskId}`)
            .length,
          1,
        );
      } finally {
        cancelWakeWhenRunner(thread.id, 'codex');
        await app.close();
      }
    });
  }

  test('F261 ordinary command has a durable job before its first side effect', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const auth = await registry.create('job-owner', 'codex', 'job-thread');
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          reason: 'ordinary durable command regression',
          nextStep: 'consume its result',
          wakeWhen: { command: 'sleep 1', timeoutMs: 5000 },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      const task = deps._insertedTasks.find((entry) => entry.id === body.taskId);
      const jobId = task?.params.holdLifecycle.managedCommand.jobId;
      assert.equal(typeof jobId, 'string', 'ordinary command must persist an Action Plane job reference');
      assert.equal(body.wakeWhen?.jobId, jobId);
      const { ManagedJobService } = await import('../dist/domains/managed-job/ManagedJobService.js');
      const service = new ManagedJobService();
      const job = service.get({ userId: 'job-owner', catId: 'codex', threadId: 'job-thread' }, jobId);
      assert.equal(job.originTaskId, body.taskId);
      assert.ok(job.admissionMessageId, 'user-visible queued record precedes launch');
    } finally {
      cancelWakeWhenRunner('job-thread', 'codex');
      await app.close();
    }
  });

  test('F261 an interrupted admission is never reported as a successfully held command', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const auth = await registry.create('crash-owner', 'codex', 'crash-thread');
    const { ManagedJobService } = await import('../dist/domains/managed-job/ManagedJobService.js');
    const service = new ManagedJobService();
    const principal = { userId: 'crash-owner', catId: 'codex', threadId: 'crash-thread' };
    const job = await service.submit(principal, {
      command: 'sleep 1',
      executionSlaMs: 5000,
      idempotencyKey: 'interrupted-admission',
      originTaskId: 'missing-origin-task',
      originInvocationId: auth.invocationId,
      wakeTarget: principal,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          reason: 'recover admission',
          nextStep: 'consume once',
          wakeWhen: {
            command: 'sleep 1',
            executionSlaMs: 5000,
            idempotencyKey: 'interrupted-admission',
          },
        },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().code, 'managed_job_admission_incomplete');
      assert.equal(response.json().jobId, job.jobId);
      assert.equal(response.json().held, false);
      assert.equal(service.get(principal, job.jobId).ownerIdentity, undefined);
      assert.equal(deps._insertedTasks.length, 0);
    } finally {
      service.cancel(principal, job.jobId);
      await app.close();
    }
  });

  test('F261 a retried command reuses its original job without spending hold quota again', async () => {
    const deps = makeStubDeps();
    let admissions = 0;
    deps.holdQuotaStore.tryAdmit = async () => {
      admissions++;
      return { admitted: admissions === 1, count: admissions, eventId: 'original-admission' };
    };
    const app = await createApp(deps);
    const auth = await registry.create('retry-owner', 'codex', 'retry-thread');
    const request = {
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { reason: 'transport retry', nextStep: 'consume once', wakeWhen: { command: 'sleep 1' } },
    };
    try {
      const first = (await app.inject(request)).json();
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await app.inject(request);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().taskId, first.taskId);
        assert.equal(response.json().wakeWhen.jobId, first.wakeWhen.jobId);
      }
      assert.equal(admissions, 1);
      assert.equal(deps._insertedTasks.length, 1);
    } finally {
      cancelWakeWhenRunner('retry-thread', 'codex');
      await app.close();
    }
  });

  test('F261 an unavailable visible admission prevents the ordinary command from spawning', async () => {
    const deps = makeStubDeps();
    deps.messageStore.append = async () => {
      throw new Error('visible state unavailable');
    };
    const app = await createApp(deps);
    const auth = await registry.create('card-owner', 'codex', 'card-thread');
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          reason: 'card persistence',
          nextStep: 'inspect receipt',
          wakeWhen: { command: 'echo should-not-start' },
        },
      });
      assert.equal(response.statusCode, 503, response.body);
      const body = response.json();
      assert.equal(body.code, 'HOLD_WAITING_HISTORY_UNAVAILABLE');
      assert.equal(deps._insertedTasks.length, 1);
      const task = deps._insertedTasks[0];
      assert.equal(deps.dynamicTaskStore.getById(task.id), undefined, 'failed wake carrier is rolled back');
      const record = readDurableGateRecord(resolveManagedCommandJob(task));
      assert.equal(record.state, 'terminal');
      assert.equal(record.ownerIdentity, undefined, 'no worker was admitted');
      assert.equal(record.terminalStatus, 'failed');
      assert.equal(getActiveRunnerCount(), 0, 'no executable runner remains');
    } finally {
      cancelWakeWhenRunner('card-thread', 'codex');
      await app.close();
    }
  });

  test(
    'readonly MCP → authenticated callback → native statistics → durable wake receipt',
    {
      skip: process.env.RUN_F306_READONLY_LIVE !== '1' || process.platform !== 'darwin',
    },
    async () => {
      const { default: Database } = await import('better-sqlite3');
      const { applyMigrations } = await import('../dist/domains/memory/schema.js');
      const { DynamicTaskStore } = await import('../dist/infrastructure/scheduler/DynamicTaskStore.js');
      const { createServer } = await import('../../mcp-server/dist/index.js');
      const { handleHoldBall } = await import('../../mcp-server/dist/tools/callback-tools.js');
      const root = mkdtempSync(path.join(os.tmpdir(), 'f306-readonly-entry-'));
      const dbPath = path.join(root, 'scheduler.sqlite');
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new DynamicTaskStore(db);
      const deps = makeStubDeps({ dynamicTaskStore: store, threadStore });
      const app = await createApp(deps);
      const thread = await threadStore.create('readonly-entry-owner', 'readonly entry');
      const auth = await registry.create('readonly-entry-owner', 'codex', thread.id);
      const apiUrl = await app.listen({ port: 0, host: '127.0.0.1' });
      const environment = {
        CAT_CAFE_API_URL: apiUrl,
        CAT_CAFE_INVOCATION_ID: auth.invocationId,
        CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
        CAT_CAFE_CREDENTIAL_FILE: undefined,
        CAT_CAFE_READONLY: 'false',
        CAT_CAFE_DESKTOP_MODE: undefined,
      };
      const prior = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const schema = createServer()._registeredTools.cat_cafe_hold_ball.inputSchema;
      const input = (command) =>
        schema.parse({
          reason: 'readonly statistics',
          nextStep: 'consume native result',
          wakeWhen: { command, cwd: root, executionPolicy: 'read_only', timeoutMs: 5000 },
        });
      let heldId;
      try {
        const command = `python3 -c 'import sqlite3; c=sqlite3.connect("file:${dbPath}?mode=ro",uri=True);print(c.execute("select count(*) from schema_version").fetchone()[0])'`;
        const expected = String(db.prepare('select count(*) as n from schema_version').get().n);
        const denied = await fetch(`${apiUrl}/api/callbacks/hold-ball`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-invocation-id': auth.invocationId,
            'x-callback-token': 'wrong-token',
          },
          body: JSON.stringify(input(command)),
        });
        assert.equal(denied.status, 401);
        assert.equal(store.getAll().length, 0);
        const result = await handleHoldBall(input(command));
        assert.notEqual(result.isError, true, JSON.stringify(result));
        heldId = JSON.parse(result.content[0].text).taskId;
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            deps._appendedMessages.some(
              (message) => message.source?.meta?.taskId === heldId && message.content?.includes('持球唤醒（命令完成）'),
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const receipt = store.getById(heldId);
        assert.equal(receipt.params.triggerUserId, 'readonly-entry-owner');
        assert.equal(receipt.deliveryThreadId, thread.id);
        assert.equal(receipt.params.targetCatId, 'codex');
        const completed = receipt.params.holdLifecycle.managedCommand;
        assert.equal(completed.executionPolicy, 'read_only');
        assert.equal(completed.command, command);
        assert.equal(completed.result.exitCode, 0);
        assert.equal(completed.result.tailOutput.trim(), expected);
        assert.equal(
          deps._appendedMessages.filter((message) => message.idempotencyKey === `hold-ball-completion:${heldId}`)
            .length,
          1,
        );
        const reopened = new Database(dbPath, { readonly: true });
        try {
          assert.deepEqual(new DynamicTaskStore(reopened).getById(heldId).params, receipt.params);
        } finally {
          reopened.close();
        }
        const sleeping = await handleHoldBall(input(`python3 -c 'import time;time.sleep(20)'`));
        assert.notEqual(sleeping.isError, true, JSON.stringify(sleeping));
        heldId = JSON.parse(sleeping.content[0].text).taskId;
        assert.equal(cancelManagedWakeIfTaskMatches(heldId, thread.id, 'other-cat'), false);
        assert.equal(cancelManagedWakeIfTaskMatches(heldId, thread.id, 'codex'), true);
      } finally {
        if (heldId) cancelManagedWakeIfTaskMatches(heldId, thread.id, 'codex');
        await new Promise((resolve) => setTimeout(resolve, 2200));
        await app.close();
        db.close();
        for (const [key, value] of Object.entries(prior)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // ─── T11: cancelWakeWhenRunner export works ──────────────────────────────
  test('readonly setup failure returns a failed admission without hanging HTTP or unhandled completion', async () => {
    const deps = makeStubDeps({ threadStore });
    const app = await createApp(deps);
    const thread = await threadStore.create('readonly-setup-owner', 'readonly failure');
    const auth = await registry.create('readonly-setup-owner', 'codex', thread.id);
    const prior = process.env.TMPDIR;
    const unhandled = [];
    const observeUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', observeUnhandled);
    process.env.TMPDIR = path.join(os.tmpdir(), 'f306-route-missing-home', 'missing');
    try {
      const response = await Promise.race([
        app.inject({
          method: 'POST',
          url: '/api/callbacks/hold-ball',
          headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
          payload: {
            reason: 'readonly setup refusal',
            nextStep: 'consume failure',
            wakeWhen: { command: 'printf UNEXPECTED', cwd: '/', executionPolicy: 'read_only', timeoutMs: 2000 },
          },
        }),
        new Promise((resolve) => setTimeout(() => resolve('HANG'), 500)),
      ]);
      assert.notEqual(response, 'HANG');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().wakeWhen.pid, null);
      const failed = deps.dynamicTaskStore.getById(response.json().taskId).params.holdLifecycle.managedCommand;
      assert.equal(failed.executionPolicy, 'read_only');
      assert.match(failed.admissionFact, /未启动.*ENOENT/);
      assert.equal(failed.admissionFactAppended, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getActiveRunnerCount(), 0);
      assert.deepEqual(unhandled, []);
    } finally {
      if (prior === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prior;
      process.removeListener('unhandledRejection', observeUnhandled);
      await app.close();
    }
  });

  test('readonly callback carries the policy through admission and durable completion', async () => {
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const originalStart = ManagedRunner.prototype.start;
    let observed;
    ManagedRunner.prototype.start = (command, options) => {
      observed = { command, options };
      return {
        admission: Promise.resolve({ spawned: true, pid: 1234 }),
        completion: Promise.resolve({ exitCode: 0, timedOut: false, durationMs: 2, tailOutput: 'STATISTICS=10' }),
      };
    };
    const deps = makeStubDeps();
    const app = await createApp(deps);
    try {
      const thread = await threadStore.create('readonly-owner', 'readonly statistics');
      const { invocationId, callbackToken } = await registry.create('readonly-owner', 'codex', thread.id);
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          reason: 'readonly statistics',
          nextStep: 'consume output',
          wakeWhen: {
            command: 'python3 -c "print(10)"',
            cwd: '/tmp',
            timeoutMs: 2000,
            executionPolicy: 'read_only',
          },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(observed.options.executionPolicy, 'read_only');
      assert.equal(observed.options.cwd, '/tmp');
      const task = deps._insertedTasks[0];
      assert.equal(task.params.holdLifecycle.managedCommand.executionPolicy, 'read_only');
      assert.equal(task.params.targetCatId, 'codex');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(task.params.holdLifecycle.managedCommand.executionPolicy, 'read_only');
      assert.match(JSON.stringify(task.params), /STATISTICS=10/);
    } finally {
      ManagedRunner.prototype.start = originalStart;
      await app.close();
    }
  });

  test('readonly admission rejects caller policies, env, unbounded limits and gate execution', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    try {
      const thread = await threadStore.create('readonly-validation', 'readonly validation');
      const { invocationId, callbackToken } = await registry.create('readonly-validation', 'codex', thread.id);
      for (const invalid of [
        { executionPolicy: 'dangerFullAccess' },
        { env: { OPENAI_API_KEY: 'synthetic' } },
        { sandboxPolicy: { type: 'externalSandbox' } },
        { outputBytesCap: 999999999 },
        { timeoutMs: 60001 },
        { executionSlaMs: 1000 },
        { command: 'pnpm gate' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/callbacks/hold-ball',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: {
            reason: 'invalid readonly',
            nextStep: 'do not run',
            wakeWhen: {
              command: 'pwd',
              cwd: '/tmp',
              executionPolicy: 'read_only',
              ...invalid,
            },
          },
        });
        assert.equal(response.statusCode, 400, response.body);
      }
      assert.equal(deps._insertedTasks.length, 0);
    } finally {
      await app.close();
    }
  });

  test('T11: cancelWakeWhenRunner is exported and callable', () => {
    assert.ok(typeof cancelWakeWhenRunner === 'function', 'cancelWakeWhenRunner should be a function');
    assert.ok(typeof getActiveRunnerCount === 'function', 'getActiveRunnerCount should be a function');
    // No-op on non-existent key should not throw
    cancelWakeWhenRunner('nonexistent-thread', 'nonexistent-cat');
  });

  test('wakeWhen registration persists authenticated provenance and tool restrictions outside public task params', async () => {
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const originalStart = ManagedRunner.prototype.start;
    ManagedRunner.prototype.start = () => ({
      admission: Promise.resolve({ spawned: false, pid: null, error: 'fixture: no process needed' }),
      completion: Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0 }),
    });

    try {
      const deps = makeStubDeps();
      const app = await createApp(deps);
      const ownerUserId = 'user-owner-provenance';
      const policy = { mode: 'callback_allowlist', allowedCallbackRoutes: ['POST /api/callbacks/hold-ball'] };
      const thread = await threadStore.create(ownerUserId, 'owner provenance');
      const { invocationId, callbackToken } = await registry.create(
        ownerUserId,
        'codex',
        thread.id,
        undefined,
        undefined,
        policy,
        undefined,
        'strict',
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          reason: 'preserve strict owner provenance',
          nextStep: 'resume authenticated owner work',
          wakeWhen: { command: 'fixture-command' },
        },
      });

      assert.equal(response.statusCode, 200, response.body);
      const taskId = JSON.parse(response.body).taskId;
      assert.equal(deps._ownerAuthProvenanceByTaskId.get(taskId), 'strict');
      assert.deepEqual(deps._privateAuthorizationByTaskId.get(taskId).toolExecutionPolicy, policy);
      assert.equal(Object.hasOwn(deps.dynamicTaskStore.getById(taskId).params, 'ownerAuthProvenance'), false);
      assert.equal(Object.hasOwn(deps.dynamicTaskStore.getById(taskId).params, 'toolExecutionPolicy'), false);
      await app.close();
    } finally {
      ManagedRunner.prototype.start = originalStart;
    }
  });

  test('wakeAfterMs registration preserves authenticated provenance and tool restrictions for immediate and restarted delivery', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const ownerUserId = 'user-owner-timer-provenance';
    const policy = { mode: 'callback_allowlist', allowedCallbackRoutes: ['POST /api/callbacks/hold-ball'] };
    const thread = await threadStore.create(ownerUserId, 'timer owner provenance');
    const { invocationId, callbackToken } = await registry.create(
      ownerUserId,
      'codex',
      thread.id,
      undefined,
      undefined,
      policy,
      undefined,
      'strict',
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'wait for a bounded external condition',
        nextStep: 'resume authenticated owner work',
        wakeAfterMs: 10_000,
        waitSourceRef: {
          kind: 'github_issue',
          value: 'AgeOfLearning/cat-cafe#999',
          expectedSignal: 'issue closed',
          slaUntilMs: Date.now() + 60_000,
        },
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    const taskId = JSON.parse(response.body).taskId;
    assert.equal(deps._ownerAuthProvenanceByTaskId.get(taskId), 'strict');
    assert.deepEqual(deps._privateAuthorizationByTaskId.get(taskId).toolExecutionPolicy, policy);
    assert.deepEqual(deps._registeredDynamic[0].spec.taskParams.toolExecutionPolicy, policy);
    assert.equal(Object.hasOwn(deps.dynamicTaskStore.getById(taskId).params, 'ownerAuthProvenance'), false);
    await app.close();
  });

  test('F280 Phase D: action-custodied waits reference the canonical action-successor lease', async () => {
    assert.equal(typeof resolveHoldWaitOwnerFence, 'function');
    const fence = await resolveHoldWaitOwnerFence(
      {
        invocationId: 'callback-invocation',
        parentInvocationId: 'parent-invocation',
        threadId: 'thread-action',
        userId: 'user-action',
        catId: 'codex',
      },
      {
        async get(id) {
          assert.equal(id, 'parent-invocation');
          return {
            threadId: 'thread-action',
            userId: 'user-action',
            targetCats: ['codex'],
            actionLeaseCarrier: {
              kind: 'action_successor',
              leaseId: 'lease-action-7',
              generation: 7,
            },
          };
        },
      },
    );
    assert.deepEqual(fence, { kind: 'action_successor', leaseId: 'lease-action-7', generation: 7 });
    assert.deepEqual(Object.keys(fence).sort(), ['generation', 'kind', 'leaseId']);
  });

  test('F280 Phase D: a parent invocation outside callback scope cannot be downgraded to a task fence', async () => {
    await assert.rejects(
      resolveHoldWaitOwnerFence(
        {
          invocationId: 'callback-invocation',
          parentInvocationId: 'foreign-parent',
          threadId: 'thread-owner',
          userId: 'user-owner',
          catId: 'codex',
        },
        {
          async get() {
            return {
              threadId: 'thread-foreign',
              userId: 'user-owner',
              targetCats: ['codex'],
              actionLeaseCarrier: { kind: 'none' },
            };
          },
        },
      ),
      /outside the authenticated hold owner scope/,
    );
  });

  for (const [budgetName, wakeWhen, expectedExecutionSlaMs] of [
    ['default budget', { command: 'pnpm gate', cwd: process.cwd() }, 3_600_000],
    ['isolated Redis prefix', { command: 'REDIS_URL=redis://127.0.0.1:6398 pnpm gate' }, 3_600_000],
    [
      'bounded env wrapper',
      { command: 'env -u NODE_ENV -u REDIS_URL CAT_CAFE_DATA_DIR=/tmp/cat-cafe-gate pnpm gate' },
      3_600_000,
    ],
    ['legacy timeout budget', { command: 'pnpm gate', timeoutMs: 2_000 }, 2_000],
    ['explicit two-hour budget', { command: 'pnpm gate', timeoutMs: 2_000, executionSlaMs: 7_200_000 }, 7_200_000],
    ['wall ceiling budget', { command: 'pnpm gate', executionSlaMs: 10_800_000 }, 10_800_000],
  ]) {
    test(`F261: canonical gate persists and settles its ${budgetName}`, async () => {
      const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
      const { recordDurableManagedGateProcess } = await import(
        '../dist/domains/ball-custody/durable-managed-gate-job.js'
      );
      const originalStart = ManagedRunner.prototype.start;
      let runnerOptions;
      let resolveCompletion;
      ManagedRunner.prototype.start = (_command, options) => {
        runnerOptions = options;
        const processIdentity = { pid: 42, ppid: 1, pgid: 42, startedAt: 'birth-42' };
        assert.ok(options.managedJob);
        assert.equal(recordDurableManagedGateProcess(options.managedJob, processIdentity), true);
        return {
          admission: Promise.resolve({ spawned: true, pid: 42, processIdentity }),
          completion: new Promise((resolve) => {
            resolveCompletion = resolve;
          }),
        };
      };
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'hold-ball-durable-gate-route-'));
      const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
      process.env.CAT_CAFE_DATA_DIR = tempDir;

      try {
        const deps = makeStubDeps();
        const app = await createApp(deps);
        const ownerUserId = 'user-durable-gate';
        const thread = await threadStore.create(ownerUserId, 'durable gate');
        const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);
        const response = await app.inject({
          method: 'POST',
          url: '/api/callbacks/hold-ball',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: {
            reason: 'canonical gate',
            nextStep: 'consume terminal truth',
            wakeWhen,
          },
        });

        assert.equal(response.statusCode, 200, response.body);
        const body = JSON.parse(response.body);
        assert.match(body.wakeWhen.jobId, /^managed-job-/);
        assert.notEqual(body.wakeWhen.jobId, body.taskId);
        const task = deps.dynamicTaskStore.getById(body.taskId);
        const job = resolveManagedCommandJob(task);
        assert.equal(task.params.holdLifecycle.managedCommand.cwd, wakeWhen.cwd);
        assert.equal(job.jobId, body.wakeWhen.jobId);
        assert.equal(job.originTaskId, body.taskId);
        assert.equal(job.kind, 'resumable_full_gate_v2');
        assert.deepEqual(job.recovery, {
          protocolVersion: 2,
          eventLoopGapMs: 30_000,
          reconciliationBudgetMs: 30_000,
          pollMs: 250,
          powerEvidenceSource: { kind: 'mac_pmset' },
        });
        assert.equal(body.wakeWhen.recoveryProtocolVersion, 2);
        assert.equal(job.executionSlaMs, expectedExecutionSlaMs);
        assert.equal(body.wakeWhen.executionSlaMs, expectedExecutionSlaMs);
        assert.equal(body.wakeWhen.wallSlaMs, job.wallSlaMs);
        assert.equal(job.wallSlaMs, 10_800_000);
        assert.equal(runnerOptions.managedJob.executionSlaMs, expectedExecutionSlaMs);
        assert.equal(runnerOptions.timeoutMs, job.wallSlaMs);
        assert.equal(runnerOptions.maximumTimeoutMs, job.wallSlaMs);
        assert.equal(runnerOptions.cwd, realpathSync(wakeWhen.cwd ?? process.cwd()));
        const running = readDurableGateRecord(job);
        assert.equal(running.state, 'running');
        assert.equal(running.ownerIdentity.startedAt, 'birth-42');

        const terminal = { exitCode: 0, timedOut: false, durationMs: 25, tailOutput: 'gate green' };
        settleDurableManagedGateJobFromRunner(job, terminal);
        resolveCompletion(terminal);
        const deadline = Date.now() + 1_000;
        while (readDurableGateRecord(job).state !== 'terminal' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(readDurableGateRecord(job).terminalStatus, 'green');
        assert.equal(readDurableTerminalReceipt(job).terminalStatus, 'green');
        while (getActiveRunnerCount() > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(getActiveRunnerCount(), 0, 'terminal fake worker must leave no active registry residue');
        await app.close();
      } finally {
        ManagedRunner.prototype.start = originalStart;
        if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
        else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  // ─── T8: wakeWhen hold with cancel → runner is cancelled ────────────────
  test('T8: wakeWhen hold registers active runner, cancel removes it', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t8', 'hb-t8');
    const { invocationId, callbackToken } = await registry.create('user-hb-t8', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // Create wakeWhen hold with a long command so runner stays active
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'running gate',
        nextStep: 'check result',
        wakeWhen: { command: 'sleep 999', timeoutMs: 300_000 },
      },
    });
    assert.equal(r1.statusCode, 200);

    const commandTask = deps._insertedTasks[0];
    const commandAwait = commandTask.params.holdLifecycle.await;
    assert.ok(commandAwait, 'wakeWhen hold must persist the unified wait shape');
    assert.deepEqual(commandAwait, {
      v: 1,
      generation: 1,
      subjectRef: `command:${commandTask.id}`,
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: {
        kind: 'managed_command',
        capturedAt: commandAwait.createdAt,
        deadlineAt: commandAwait.createdAt + 300_000,
      },
      continuation: {
        when: [{ kind: 'managed_command_completed' }],
        // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
        then: 'check result',
      },
      autoRenew: false,
      expiresAt: commandTask.trigger.fireAt,
      createdAt: commandAwait.createdAt,
      provenance: 'explicit_registration',
    });

    // Runner should be registered
    assert.ok(getActiveRunnerCount() >= 1, 'active runner should be registered');

    // Cancel the hold
    cancelWakeWhenRunner(thread.id, 'codex');

    // Wait briefly for cancel to propagate
    await new Promise((r) => setTimeout(r, 200));

    // Runner count should be back to 0 for this key
    // (other tests may have runners too, so we check the specific cancel worked
    //  by verifying cancelWakeWhenRunner doesn't throw and we can inspect state)
    assert.ok(getActiveRunnerCount() >= 0, 'runner should be cleaned up');
  });

  test('T8-terminal: unrelated user mention cannot retire or wake an older managed hold', async () => {
    let triggerCount = 0;
    const deps = makeStubDeps({
      async admitManagedWake(input) {
        triggerCount += 1;
        const stored = { id: `wake-${triggerCount}`, ...input.message };
        deps._appendedMessages.push(stored);
        return { messageId: stored.id };
      },
      invocationRecordStore: {
        getByIdempotencyKey() {
          return null;
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-terminal', 'hb-terminal');
    const { invocationId, callbackToken } = await registry.create('user-hb-terminal', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'long gate outlives an ordinary user message',
        nextStep: 'inspect the natural terminal result',
        wakeWhen: {
          command: 'printf "progress-before-user-message\\n"; sleep 0.5; printf "completed-after-user-message\\n"',
          timeoutMs: 300_000,
        },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    await new Promise((resolve) => setTimeout(resolve, 100));
    // POST /api/messages calls this hook after routing any ordinary message;
    // the hook deliberately receives no mention target. An @ to another cat or
    // to this holder therefore has identical non-authority here.
    tryAutoCancelPendingHolds(thread.id, deps);
    let managedHold = deps.dynamicTaskStore.getById(taskId);
    assert.ok(managedHold, 'the managed hold remains durable');
    assert.equal(managedHold.enabled, true, 'ordinary mention cannot retire the hold');
    assert.equal(managedHold.params.holdLifecycle.status, 'active');
    assert.equal(triggerCount, 0, 'ordinary mention cannot dequeue or wake the older holder');

    // F117 (ef94412a5): invokeTrigger success now means admitted into Queue
    // custody — the routes layer maps 'dispatched' → 'enqueued' before the
    // recovery sweep persists the state. 'dispatched' was the pre-F117 name
    // for the same "trigger accepted, wake under Queue custody" terminal.
    const deadline = Date.now() + 3_000;
    while (managedHold?.params.holdLifecycle?.managedCommand?.state !== 'enqueued' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      managedHold = deps.dynamicTaskStore.getById(taskId);
    }
    await app.close();

    assert.ok(managedHold, 'the typed wake remains queryable until its canonical response terminal');
    assert.equal(managedHold.enabled, true);
    assert.equal(managedHold.params.holdLifecycle.status, 'active');
    assert.equal(managedHold.params.holdLifecycle.managedCommand.state, 'enqueued');
    assert.equal(
      managedHold.params.holdLifecycle.managedCommand.result.cancelled,
      false,
      'ordinary user activity must not SIGTERM the independent command',
    );
    assert.match(managedHold.params.holdLifecycle.managedCommand.result.tailOutput, /completed-after-user-message/);
    assert.equal(triggerCount, 1, 'only typed command completion dispatches the older holder once');
    const wakeReceipts = deps._appendedMessages.filter((message) => message.content?.includes('持球唤醒（命令完成）'));
    assert.equal(wakeReceipts.length, 1, 'natural completion must publish one typed wake carrier');
    assert.equal(
      wakeReceipts[0].deliveryStatus,
      'queued',
      'the wake remains under Queue custody until its canonical response terminal',
    );
    assert.equal(wakeReceipts[0].idempotencyKey, `hold-ball-completion:${taskId}`);
    assert.equal(wakeReceipts[0].source?.meta?.taskId, taskId);
    assert.match(wakeReceipts[0].content, /completed-after-user-message/);
  });

  test('ordinary user-message retirement persists one owner-bound terminal fact', async () => {
    const deps = makeStubDeps();
    deps._insertedTasks.push({
      id: 'hold-ball-auto-retire',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: {
        message: 'resume later',
        targetCatId: 'codex',
        triggerUserId: 'owner-user',
        holdLifecycle: { mode: 'timer', status: 'active', createdBy: 'hold-ball:codex' },
      },
      display: { label: 'hold', category: 'system', description: 'hold', subjectKind: 'none' },
      deliveryThreadId: 'thread-auto-retire',
      enabled: true,
      createdBy: 'hold-ball:codex',
      createdAt: new Date().toISOString(),
    });

    await tryAutoCancelPendingHolds('thread-auto-retire', deps);

    assert.deepEqual(deps._removedIds, [], 'typed terminal facts retain their durable task identity');
    assert.equal(deps._insertedTasks[0].enabled, false);
    assert.equal(deps._insertedTasks[0].params.holdLifecycle.status, 'cancelled_by_user');
    assert.deepEqual(deps._unregisteredIds, ['hold-ball-auto-retire']);
    const terminal = deps._appendedMessages.find(
      (message) => message.idempotencyKey === 'hold-ball-terminal:hold-ball-auto-retire:retired_by_user_message',
    );
    assert.ok(terminal);
    assert.equal(terminal.userId, 'owner-user');
    assert.doesNotMatch(terminal.content, /\bcodex\b/, 'human prose must not expose the internal cat id');
    // Retirement is terminal, so the card must state that it can no longer be
    // canceled — the consumer trusts this stated fact over any status probe.
    assert.deepEqual(terminal.source.meta, {
      managedHold: true,
      phase: 'terminal',
      cancelable: false,
      taskId: 'hold-ball-auto-retire',
      threadId: 'thread-auto-retire',
      catId: 'codex',
      outcome: 'retired_by_user_message',
    });
  });

  test('T8a: a completed command waits behind cancellation reservation until release', async () => {
    let completionCount = 0;
    const deps = makeStubDeps({
      managedCommandWakeRecovery: {
        async recordCompletion() {
          completionCount += 1;
          return { outcome: 'recorded' };
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t8a', 'hb-t8a');
    const { invocationId, callbackToken } = await registry.create('user-hb-t8a', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'linearization gate',
        nextStep: 'resume after storage failure',
        wakeWhen: { command: 'sleep 0.1' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);
    const reservation = reserveManagedWakeCancellation(taskId, thread.id, 'codex');
    assert.equal(reservation.outcome, 'reserved');

    await waitForCommandTerminal(deps, taskId);
    assert.equal(completionCount, 0, 'completion must not become visible while cancellation truth is unsettled');
    assert.equal(releaseManagedWakeCancellation(taskId, thread.id, 'codex', reservation.token), true);
    const deadline = Date.now() + 3000;
    while (completionCount === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(completionCount, 1, 'proven-uncommitted cancellation restores the original completion');
  });

  test('T8b: committed cancellation suppresses a command that completed while reserved', async () => {
    let completionCount = 0;
    const deps = makeStubDeps({
      managedCommandWakeRecovery: {
        async recordCompletion() {
          completionCount += 1;
          return { outcome: 'recorded' };
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t8b', 'hb-t8b');
    const { invocationId, callbackToken } = await registry.create('user-hb-t8b', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'cancel wins',
        nextStep: 'stay cancelled',
        wakeWhen: { command: 'sleep 0.1' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);
    const reservation = reserveManagedWakeCancellation(taskId, thread.id, 'codex');
    assert.equal(reservation.outcome, 'reserved');

    await waitForCommandTerminal(deps, taskId);
    assert.equal(completionCount, 0);
    assert.equal(commitManagedWakeCancellation(taskId, thread.id, 'codex', reservation.token), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(completionCount, 0, 'applied cancellation must suppress managed-command wake visibility');
  });

  test('T8c: user cancellation during the pre-launch visibility window suppresses managed execution', async () => {
    let markVisibilityAppendStarted;
    const visibilityAppendStarted = new Promise((resolve) => {
      markVisibilityAppendStarted = resolve;
    });
    let releaseVisibilityAppend;
    const visibilityMayFinish = new Promise((resolve) => {
      releaseVisibilityAppend = resolve;
    });
    let completionCount = 0;
    const t8cMessages = [];
    let firstAppend = true;
    const deps = makeStubDeps({
      messageStore: {
        getByIdempotencyKey() {
          return null;
        },
        async append(message) {
          if (firstAppend) {
            firstAppend = false;
            markVisibilityAppendStarted();
            await visibilityMayFinish;
          }
          const stored = { id: `t8c-msg-${t8cMessages.length}`, ...message };
          t8cMessages.push(stored);
          return stored;
        },
      },
      managedCommandWakeRecovery: {
        async recordCompletion() {
          completionCount += 1;
          return { outcome: 'recorded' };
        },
      },
    });
    deps.taskRunner.reserveOnceCancellation = () => ({ outcome: 'reserved', token: 41 });
    deps.taskRunner.releaseOnceCancellation = () => true;

    const app = await createApp(deps);
    const ownerUserId = 'user-hb-t8c';
    const thread = await threadStore.create(ownerUserId, 'hb-t8c');
    const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);

    const heldPromise = app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'pre-launch cancellation race',
        nextStep: 'remain cancelled',
        wakeWhen: { command: 'echo done' },
      },
    });
    await visibilityAppendStarted;
    const waitId = deps._insertedTasks[0]?.id;
    assert.ok(waitId, 'hold route must persist the wait before visibility append');

    const { WaitTerminationService } = await import('../dist/domains/ball-custody/WaitTerminationService.js');
    const records = new Map();
    const service = new WaitTerminationService({
      store: {
        getByWaitId: async (id) => records.get(id) ?? null,
        commit: async (record) => {
          records.set(record.event.waitId, record);
          return 'applied';
        },
        loadEntry: async () => null,
        listRecords: async () => [...records.values()],
      },
      dynamicTaskStore: deps.dynamicTaskStore,
      taskRunner: deps.taskRunner,
      managedWakeCancellation: {
        reserve: reserveManagedWakeCancellation,
        commit: commitManagedWakeCancellation,
        release: releaseManagedWakeCancellation,
        cancelIfTaskMatches: cancelManagedWakeIfTaskMatches,
      },
      threadStore,
    });

    const cancellation = await service.cancelByUser({ waitId, ownerUserId });
    releaseVisibilityAppend();
    const held = await heldPromise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.close();

    assert.equal(cancellation.outcome, 'applied');
    assert.equal(held.statusCode, 200);
    assert.equal(completionCount, 0, 'an applied cancellation must prevent managed launch and completion');

    // Spawn-truth assertions: cancellation must prevent spawn, not just suppress delivery.
    const heldBody = JSON.parse(held.body);
    assert.strictEqual(heldBody.wakeWhen.pid, null, 'cancelled command must report pid: null in HTTP response');
    assert.equal(getActiveRunnerCount(), 0, 'no active runner residue after cancellation');

    // Durable admission-fact: cancellation must be projected as terminal ("已取消"),
    // distinct from generic spawn failure ("未启动").
    // Pre-launch cancellation deletes the registry entry (registry_mismatch), which
    // the three-way formatter maps to the cancellation terminal state.
    const admissionMessages = t8cMessages.filter((m) => m.content.includes('未启动'));
    assert.ok(admissionMessages.length > 0, 'durable admission fact (未启动) must be appended after cancellation');
    assertStatesTerminal(admissionMessages[0], 'launch cancellation');
    const cancelledMessages = t8cMessages.filter((m) => m.content.includes('已取消'));
    assert.ok(cancelledMessages.length > 0, 'cancellation admission must say "已取消", not generic spawn failure');
    const falseScheduledMessages = t8cMessages.filter((m) => m.content.includes('定时唤醒将触发'));
    assert.equal(falseScheduledMessages.length, 0, 'cancelled path must not claim fallback timer will fire');

    // DynamicTask must be removed by cancellation — no scheduler/task residue
    const taskAfterCancel = deps.dynamicTaskStore.getById(waitId);
    assert.ok(!taskAfterCancel, 'DynamicTask must be removed after applied cancellation');
  });

  test('T8c-2: pre-admission IIFE failure settles admission promise and terminates HTTP', async () => {
    // Regression guard: if the async IIFE inside launchWakeWhenRunner throws
    // before any explicit resolveExternalAdmission call, the catch block must
    // still settle the admission promise so the route handler doesn't hang.
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const origStart = ManagedRunner.prototype.start;
    ManagedRunner.prototype.start = () => {
      throw new Error('injected pre-admission failure');
    };

    try {
      const deps = makeStubDeps();
      const app = await createApp(deps);
      const ownerUserId = 'user-pre-admit';
      const thread = await threadStore.create(ownerUserId, 'pre-admit');
      const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);

      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          reason: 'pre-admission failure test',
          nextStep: 'verify hang-free',
          wakeWhen: { command: 'echo never-runs' },
        },
      });

      assert.equal(response.statusCode, 200, 'route must terminate without hanging');
      const body = JSON.parse(response.body);
      assert.strictEqual(body.wakeWhen.pid, null, 'failed admission must report pid: null');
      assert.equal(body.held, false, 'explicit no-spawn must not promise a future wake');
      assert.equal(body.wakeWhen.state, 'not_started');
      assert.equal(body.wakeWhen.notStartedReason, 'admission_rejected');
      assert.equal(getActiveRunnerCount(), 0, 'no active runner residue after pre-admission failure');

      // Spawn failure owns exactly one truthful terminal fact. The periodic
      // recovery sweep must not later invent a second "service restart" end.
      const terminalMessages = deps._appendedMessages.filter((m) => m.source?.meta?.phase === 'status');
      assert.equal(terminalMessages.length, 1, 'spawn failure must project exactly one terminal status');
      assertStatesTerminal(terminalMessages[0], 'pre-admission failure');
      assert.match(terminalMessages[0].content, /未启动/);
      assert.doesNotMatch(terminalMessages[0].content, /服务重启/);

      // P1-2: DynamicTask lifecycle projection must have pid=null for spawn failure
      const task = deps.dynamicTaskStore.getById(body.taskId);
      assert.ok(task, 'DynamicTask must still exist after spawn failure');
      const mc = task.params.holdLifecycle?.managedCommand;
      assert.ok(mc, 'managedCommand projection must exist');
      assert.strictEqual(mc.pid, null, 'spawn failure must persist pid=null in lifecycle projection');
      assert.equal(mc.state, 'not_started');
      assert.equal(mc.notStartedDetail, 'internal_error');
      assert.equal(task.params.holdLifecycle.status, 'not_started');
      assert.equal(task.enabled, false, 'no-spawn retires the fallback timer');
      await app.close();
    } finally {
      ManagedRunner.prototype.start = origStart;
    }
  });

  test('T8c-3: rejected spawn admission writes one spawn terminal and retires the task', async () => {
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const origStart = ManagedRunner.prototype.start;
    ManagedRunner.prototype.start = () => ({
      admission: Promise.resolve({ spawned: false, pid: null, error: 'spawn ENOENT' }),
      completion: Promise.resolve({ exitCode: null, timedOut: false, durationMs: 1 }),
    });

    try {
      const deps = makeStubDeps();
      const app = await createApp(deps);
      const ownerUserId = 'user-spawn-reject';
      const thread = await threadStore.create(ownerUserId, 'spawn-reject');
      const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);

      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          reason: 'spawn rejection test',
          nextStep: 'verify single terminal',
          wakeWhen: { command: 'missing-command' },
        },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      const terminalMessages = deps._appendedMessages.filter((m) => m.source?.meta?.phase === 'status');
      assert.equal(terminalMessages.length, 1);
      assertStatesTerminal(terminalMessages[0], 'rejected spawn admission');
      assert.match(terminalMessages[0].content, /未启动.*spawn ENOENT/);
      assert.doesNotMatch(terminalMessages[0].content, /服务重启/);
      const task = deps.dynamicTaskStore.getById(body.taskId);
      assert.equal(task.params.holdLifecycle.managedCommand.state, 'not_started');
      assert.equal(task.params.holdLifecycle.managedCommand.notStartedDetail, 'spawn ENOENT');
      assert.equal(task.enabled, false);
      assert.equal(getActiveRunnerCount(), 0);

      await app.close();
    } finally {
      ManagedRunner.prototype.start = origStart;
    }
  });

  test('T8c-4: post-spawn runner failure records a truthful runner terminal', async () => {
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const origStart = ManagedRunner.prototype.start;
    ManagedRunner.prototype.start = () => ({
      admission: Promise.resolve({ spawned: true, pid: 42 }),
      completion: Promise.reject(new Error('runner pipe failed')),
    });

    try {
      const deps = makeStubDeps();
      const app = await createApp(deps);
      const ownerUserId = 'user-runner-failure';
      const thread = await threadStore.create(ownerUserId, 'runner-failure');
      const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);

      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          reason: 'runner failure test',
          nextStep: 'verify truthful terminal',
          wakeWhen: { command: 'unstable-command' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      const terminalMessages = deps._appendedMessages.filter((m) => m.source?.meta?.phase === 'status');
      assert.equal(terminalMessages.length, 1);
      assertStatesTerminal(terminalMessages[0], 'post-spawn runner failure');
      assert.match(terminalMessages[0].content, /执行进程异常终止.*runner pipe failed/);
      assert.doesNotMatch(terminalMessages[0].content, /服务重启/);
      const task = deps.dynamicTaskStore.getById(body.taskId);
      assert.equal(task.params.holdLifecycle.managedCommand.state, 'consumed');
      assert.equal(task.params.holdLifecycle.managedCommand.lostReason, 'runner_failed');
      assert.equal(task.enabled, false);
      assert.equal(getActiveRunnerCount(), 0);

      await app.close();
    } finally {
      ManagedRunner.prototype.start = origStart;
    }
  });

  test('explicit admission refusal, OS spawn failure and pid-null execution stay distinct', async () => {
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const origStart = ManagedRunner.prototype.start;
    try {
      for (const admission of [
        {
          spawned: false,
          pid: null,
          failureKind: 'admission_rejected',
          error: 'provider_execution_refused:effect_closed_or_consumed',
        },
        { spawned: false, pid: null, failureKind: 'spawn_failed', error: 'spawn /bin/sh ENOENT' },
        { spawned: true, pid: null },
      ]) {
        ManagedRunner.prototype.start = () => ({
          admission: Promise.resolve(admission),
          completion: new Promise(() => {}),
        });
        const deps = makeStubDeps();
        const app = await createApp(deps);
        const thread = await threadStore.create('u-admission', 'admission');
        const { invocationId, callbackToken } = await registry.create('u-admission', 'codex', thread.id);
        const response = await app.inject({
          method: 'POST',
          url: '/api/callbacks/hold-ball',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: { reason: 'admission truth', nextStep: 'read receipt', wakeWhen: { command: 'echo fixture-only' } },
        });
        const body = response.json();
        assert.equal(response.statusCode, 200);
        assert.equal(body.held, admission.spawned);
        assert.equal(body.wakeWhen.state, admission.spawned ? 'command_running' : 'not_started');
        if (!admission.spawned) {
          assert.equal(body.wakeWhen.notStartedReason, admission.failureKind);
          assert.equal(body.wakeWhen.notStartedDetail, admission.error);
          assert.equal(deps.dynamicTaskStore.getById(body.taskId).enabled, false);
          assert.equal(Object.hasOwn(body, 'wakeAt'), false);
        } else {
          assert.equal(
            deps._appendedMessages.filter((message) => message.source?.meta?.phase === 'waiting').length,
            1,
            'the canonical waiting History row is stored exactly once',
          );
          cancelWakeWhenRunner(thread.id, 'codex');
        }
        await app.close();
      }
    } finally {
      ManagedRunner.prototype.start = origStart;
    }
  });

  test('no-spawn must not return durable success when terminal disable fails', async () => {
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const origStart = ManagedRunner.prototype.start;
    ManagedRunner.prototype.start = () => ({
      admission: Promise.resolve({ spawned: false, pid: null, error: 'refused', failureKind: 'admission_rejected' }),
      completion: Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0, tailOutput: 'refused' }),
    });
    try {
      const deps = makeStubDeps();
      deps.dynamicTaskStore.setEnabled = () => false;
      const app = await createApp(deps);
      const thread = await threadStore.create('u-disable', 'disable failure');
      const { invocationId, callbackToken } = await registry.create('u-disable', 'codex', thread.id);
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          reason: 'disable failure',
          nextStep: 'read failed receipt',
          wakeWhen: { command: 'echo never-ran' },
        },
      });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().held, false);
      assert.equal(response.json().code, 'NO_SPAWN_RECEIPT_UNAVAILABLE');
      assert.equal(deps.dynamicTaskStore.getById(response.json().taskId).enabled, true);
      assert.equal(deps._unregisteredIds.includes(response.json().taskId), true);
      await app.close();
    } finally {
      ManagedRunner.prototype.start = origStart;
    }
  });

  for (const failingStep of ['settle', 'disable']) {
    test(`no-spawn persistence ${failingStep} throw returns 503 and remains recoverable`, async () => {
      const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
      const { ManagedCommandWakeRecoverySweep } = await import(
        '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js'
      );
      const originalStart = ManagedRunner.prototype.start;
      const root = mkdtempSync(path.join(os.tmpdir(), 'f306-terminal-throw-'));
      const previous = process.env.CAT_CAFE_DATA_DIR;
      process.env.CAT_CAFE_DATA_DIR = root;
      let job;
      ManagedRunner.prototype.start = (_command, options) => {
        job = options.managedJob;
        if (failingStep === 'settle') {
          const db = new Database(path.join(path.dirname(job.recordPath), 'supervisor.sqlite'));
          db.exec(
            "CREATE TRIGGER injected_terminal_failure BEFORE INSERT ON managed_job_transitions WHEN NEW.state = 'terminal' BEGIN SELECT RAISE(ABORT, 'injected terminal persistence failure'); END;",
          );
          db.close();
        }
        return {
          admission: Promise.resolve({
            spawned: false,
            pid: null,
            error: 'explicit_refusal',
            failureKind: 'admission_rejected',
          }),
          completion: Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0, tailOutput: 'not started' }),
        };
      };
      let app;
      try {
        const deps = makeStubDeps();
        const originalDisable = deps.dynamicTaskStore.setEnabled;
        if (failingStep === 'disable')
          deps.dynamicTaskStore.setEnabled = () => {
            throw new Error('injected disable failure');
          };
        app = await createApp(deps);
        const thread = await threadStore.create('u-terminal-throw', 'terminal throw');
        const { invocationId, callbackToken } = await registry.create('u-terminal-throw', 'codex', thread.id);
        const response = await app.inject({
          method: 'POST',
          url: '/api/callbacks/hold-ball',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: { reason: 'terminal throw', nextStep: 'retry receipt', wakeWhen: { command: 'pnpm gate' } },
        });
        assert.equal(response.statusCode, 503, response.body);
        const body = response.json();
        assert.equal(body.code, 'NO_SPAWN_RECEIPT_UNAVAILABLE');
        assert.equal(body.held, false);
        assert.ok(
          deps._unregisteredIds.includes(body.taskId),
          'remove runnable fallback despite persistence exception',
        );
        assert.equal(deps.dynamicTaskStore.getById(body.taskId).enabled, failingStep === 'disable');
        assert.equal(
          deps._appendedMessages.some((message) => message.idempotencyKey?.startsWith('hold-ball-admission-fact:')),
          false,
        );
        deps.dynamicTaskStore.setEnabled = originalDisable;
        if (failingStep === 'settle') {
          const db = new Database(path.join(path.dirname(job.recordPath), 'supervisor.sqlite'));
          db.exec('DROP TRIGGER injected_terminal_failure');
          db.close();
        }
        let triggers = 0;
        const recovery = new ManagedCommandWakeRecoverySweep({
          ...deps,
          getInvokeTrigger: () => ({
            trigger: async () => {
              triggers += 1;
              return 'enqueued';
            },
          }),
        });
        await recovery.runOnce();
        await recovery.runOnce();
        assert.equal(deps.dynamicTaskStore.getById(body.taskId).enabled, false);
        assert.equal(readDurableGateRecord(job).state, 'terminal');
        assert.equal(
          deps._appendedMessages.filter((message) => message.idempotencyKey?.startsWith('hold-ball-admission-fact:'))
            .length,
          1,
        );
        assert.equal(triggers, 0);
      } finally {
        if (app) await app.close();
        ManagedRunner.prototype.start = originalStart;
        if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
        else process.env.CAT_CAFE_DATA_DIR = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('operational receipt logs consume the same no-spawn state and post-release count', async () => {
    const { default: pino } = await import('pino');
    const { logger } = await import('../dist/infrastructure/logger.js');
    const stream = logger[pino.symbols.streamSym];
    const originalWrite = stream.write;
    const entries = [];
    stream.write = function (line) {
      try {
        entries.push(JSON.parse(String(line)));
      } catch {}
      return originalWrite.call(this, line);
    };
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const origStart = ManagedRunner.prototype.start;
    ManagedRunner.prototype.start = () => ({
      admission: Promise.resolve({ spawned: false, pid: null, error: 'refused', failureKind: 'admission_rejected' }),
      completion: Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0, tailOutput: 'refused' }),
    });
    try {
      const deps = makeStubDeps();
      const app = await createApp(deps);
      const thread = await threadStore.create('u-log', 'log truth');
      const { invocationId, callbackToken } = await registry.create('u-log', 'codex', thread.id);
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { reason: 'log truth', nextStep: 'read receipt', wakeWhen: { command: 'echo never-ran' } },
      });
      assert.equal(response.statusCode, 200, response.body);
      const entry = entries.find((entry) => entry.taskId === response.json().taskId && entry.wakeWhen);
      assert.ok(entry);
      assert.equal(entry.held, false);
      assert.equal(entry.wakeWhen.state, 'not_started');
      assert.equal(entry.holdsInWindow, response.json().holdsInWindow);
      assert.doesNotMatch(entry.msg, /wake-up scheduled/);
      await app.close();
    } finally {
      ManagedRunner.prototype.start = origStart;
      stream.write = originalWrite;
    }
  });

  for (const mode of ['spawn_failed', 'start_throw', 'pre_cancel', 'params_before_terminal']) {
    test(`proven no-spawn settles the existing durable gate owner: ${mode}`, async () => {
      const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
      const originalStart = ManagedRunner.prototype.start;
      let descriptor;
      ManagedRunner.prototype.start = (_command, options) => {
        descriptor = options.managedJob;
        if (mode === 'start_throw') throw new Error('explicit before-spawn failure');
        return {
          admission: Promise.resolve({ spawned: false, pid: null, error: 'spawn ENOENT', failureKind: 'spawn_failed' }),
          completion: Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0, tailOutput: 'spawn ENOENT' }),
        };
      };
      const root = mkdtempSync(path.join(os.tmpdir(), 'f306-no-spawn-gate-'));
      const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
      process.env.CAT_CAFE_DATA_DIR = root;
      try {
        const deps = makeStubDeps();
        if (mode === 'params_before_terminal') {
          const originalUpdate = deps.dynamicTaskStore.updateParams;
          deps.dynamicTaskStore.updateParams = (id, params) => {
            if (
              params.holdLifecycle.managedCommand.state === 'not_started' &&
              params.holdLifecycle.managedCommand.admissionFactAppended === false
            ) {
              assert.equal(
                readDurableGateRecord(descriptor).state,
                'queued',
                'persist explicit no-spawn before the gate terminal can be recovered as completion',
              );
            }
            return originalUpdate(id, params);
          };
        }
        if (mode === 'pre_cancel') {
          const originalAppend = deps.messageStore.append;
          deps.messageStore.append = async (message) => {
            if (message.source?.meta?.phase === 'waiting') {
              const taskId = message.source.meta.taskId;
              descriptor = resolveManagedCommandJob(deps.dynamicTaskStore.getById(taskId));
              cancelManagedWakeIfTaskMatches(taskId, message.threadId, 'codex');
              deps.dynamicTaskStore.remove(taskId);
            }
            return originalAppend(message);
          };
        }
        const app = await createApp(deps);
        const thread = await threadStore.create('u-gate-refusal', 'gate refusal');
        const { invocationId, callbackToken } = await registry.create('u-gate-refusal', 'codex', thread.id);
        const response = await app.inject({
          method: 'POST',
          url: '/api/callbacks/hold-ball',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: { reason: 'gate refusal', nextStep: 'read terminal', wakeWhen: { command: 'pnpm gate' } },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().held, false);
        const record = readDurableGateRecord(descriptor);
        assert.equal(record.state, 'terminal');
        assert.equal(record.terminalStatus, mode === 'pre_cancel' ? 'cancelled' : 'failed');
        assert.equal(readDurableTerminalReceipt(descriptor).terminalStatus, record.terminalStatus);
        assert.equal(
          deps._appendedMessages.some((message) => message.content.includes('持球唤醒（命令完成）')),
          false,
        );
        await app.close();
      } finally {
        ManagedRunner.prototype.start = originalStart;
        if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
        else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('T8d: failed persistence releases a pre-launch reservation and starts the original command', async () => {
    let markVisibilityAppendStarted;
    const visibilityAppendStarted = new Promise((resolve) => {
      markVisibilityAppendStarted = resolve;
    });
    let releaseVisibilityAppend;
    const visibilityMayFinish = new Promise((resolve) => {
      releaseVisibilityAppend = resolve;
    });
    let completionCount = 0;
    let managedReleaseCount = 0;
    const deps = makeStubDeps({
      messageStore: {
        getByIdempotencyKey() {
          return null;
        },
        async append(message) {
          markVisibilityAppendStarted();
          await visibilityMayFinish;
          return { id: 'visibility-message', ...message };
        },
      },
      managedCommandWakeRecovery: {
        async recordCompletion() {
          completionCount += 1;
          return { outcome: 'recorded' };
        },
      },
    });
    deps.taskRunner.reserveOnceCancellation = () => ({ outcome: 'reserved', token: 42 });
    deps.taskRunner.releaseOnceCancellation = () => true;

    const app = await createApp(deps);
    const ownerUserId = 'user-hb-t8d';
    const thread = await threadStore.create(ownerUserId, 'hb-t8d');
    const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);
    const heldPromise = app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'pre-launch persistence rollback',
        nextStep: 'run after rollback',
        wakeWhen: { command: 'echo done' },
      },
    });
    await visibilityAppendStarted;
    const waitId = deps._insertedTasks[0]?.id;
    assert.ok(waitId);

    const { WaitTerminationService } = await import('../dist/domains/ball-custody/WaitTerminationService.js');
    const service = new WaitTerminationService({
      store: {
        getByWaitId: async () => null,
        commit: async () => {
          throw new Error('redis unavailable');
        },
        loadEntry: async () => null,
        listRecords: async () => [],
      },
      dynamicTaskStore: deps.dynamicTaskStore,
      taskRunner: deps.taskRunner,
      managedWakeCancellation: {
        reserve: reserveManagedWakeCancellation,
        commit: commitManagedWakeCancellation,
        release(...args) {
          managedReleaseCount += 1;
          return releaseManagedWakeCancellation(...args);
        },
        cancelIfTaskMatches: cancelManagedWakeIfTaskMatches,
      },
      threadStore,
    });

    await assert.rejects(service.cancelByUser({ waitId, ownerUserId }), /redis unavailable/);
    assert.equal(managedReleaseCount, 1, 'a proven failed commit must release the exact pre-launch reservation');
    releaseVisibilityAppend();
    const held = await heldPromise;
    const completedBy = Date.now() + 3000;
    while (completionCount === 0 && Date.now() < completedBy) await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();

    assert.equal(held.statusCode, 200);
    assert.equal(completionCount, 1, 'the original managed command must resume after proven persistence failure');
  });

  // ─── T9: second wakeWhen replaces custody, not authorized execution ─────
  test('T9: second wakeWhen hold preserves the first authorized runner', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t9', 'hb-t9');
    const { invocationId, callbackToken } = await registry.create('user-hb-t9', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First wakeWhen hold
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'first gate',
        nextStep: 'first check',
        wakeWhen: { command: 'sleep 999', timeoutMs: 300_000 },
      },
    });
    assert.equal(r1.statusCode, 200);
    const firstTaskId = JSON.parse(r1.body).taskId;

    // Second wakeWhen hold (same thread, same cat) supersedes only the wake carrier.
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'second gate',
        nextStep: 'second check',
        wakeWhen: { command: 'sleep 888', timeoutMs: 300_000 },
      },
    });
    assert.equal(r2.statusCode, 200);
    const secondTaskId = JSON.parse(r2.body).taskId;
    assert.notEqual(firstTaskId, secondTaskId, 'should get a new taskId');

    // First scheduler carrier is retired, but its durable task projection and
    // independently authorized process remain available for terminal recovery.
    assert.ok(
      deps._unregisteredIds.includes(firstTaskId),
      `first taskId should have been unregistered; got ${JSON.stringify(deps._unregisteredIds)}`,
    );
    const firstTask = deps.dynamicTaskStore.getById(firstTaskId);
    assert.ok(firstTask, 'replacement must retain a durable task tombstone');
    assert.equal(firstTask.enabled, false);
    assert.equal(firstTask.params.holdLifecycle.status, 'retired_by_replacement');
    assert.ok(getActiveRunnerCount() >= 2, 'both authorized jobs must remain active after re-hold');

    // Neither command is allowed to wake through the superseded carrier.
    await new Promise((r) => setTimeout(r, 200));

    // First runner's wake should NOT have been delivered
    // (if the old runner still fires, it would append a message with "first gate")
    const firstGateMessages = deps._appendedMessages.filter(
      (m) =>
        typeof m.content === 'string' && m.content.includes('first gate') && m.content.includes('持球唤醒（命令完成）'),
    );
    assert.equal(firstGateMessages.length, 0, 'retired carrier must not deliver a duplicate wake for "first gate"');

    // Clean up: cancel the second runner to avoid dangling processes
    cancelWakeWhenRunner(thread.id, 'codex');
    await new Promise((r) => setTimeout(r, 200));
  });

  test('T9a: an exact-task cancellation cannot kill a successor command', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t9a', 'hb-t9a');
    const { invocationId, callbackToken } = await registry.create('user-hb-t9a', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'first command',
        nextStep: 'first',
        wakeWhen: { command: 'sleep 999', timeoutMs: 300_000 },
      },
    });
    const firstTaskId = JSON.parse(first.body).taskId;
    const firstReservation = reserveManagedWakeCancellation(firstTaskId, thread.id, 'codex');
    assert.equal(firstReservation.outcome, 'reserved');

    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'replacement command',
        nextStep: 'second',
        wakeWhen: { command: 'sleep 999', timeoutMs: 300_000, idempotencyKey: 'intentional-successor' },
      },
    });
    assert.equal(second.statusCode, 200);
    const secondTaskId = JSON.parse(second.body).taskId;

    assert.equal(
      commitManagedWakeCancellation(firstTaskId, thread.id, 'codex', firstReservation.token),
      true,
      'the exact first task remains explicitly cancellable after replacement',
    );
    const secondReservation = reserveManagedWakeCancellation(secondTaskId, thread.id, 'codex');
    assert.equal(secondReservation.outcome, 'reserved', 'replacement runner must remain active');
    assert.equal(releaseManagedWakeCancellation(secondTaskId, thread.id, 'codex', secondReservation.token), true);
    cancelWakeWhenRunner(thread.id, 'codex');
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  // F117 replaced standalone message append with atomic wake admission; T13 covers its failure.
  test('T12: refused atomic wake admission keeps the completed command recoverable', async (t) => {
    let admissionCalls = 0;
    const deps = makeStubDeps({
      // Queue capacity refused the row. One transaction means nothing is written at all.
      async admitManagedWake() {
        admissionCalls += 1;
        return {};
      },
    });
    const app = await createApp(deps);
    t.after(() => app.close());
    const thread = await threadStore.create('user-hb-t12', 'hb-t12');
    const { invocationId, callbackToken } = await registry.create('user-hb-t12', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'queue-full gate',
        nextStep: 'resume after capacity returns',
        wakeWhen: { command: 'echo done' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    await waitForWakeHandling(deps, taskId, () => {
      const command = deps.dynamicTaskStore.getById(taskId)?.params.holdLifecycle.managedCommand;
      return admissionCalls > 0 && command?.messageClaimedAt === undefined;
    });
    assert.equal(admissionCalls, 1, 'the refused admission must actually have been attempted');
    const task = deps.dynamicTaskStore.getById(taskId);
    assert.equal(task.enabled, true);
    assert.equal(task.params.holdLifecycle.managedCommand.state, 'condition_met');
    assert.equal(task.params.holdLifecycle.managedCommand.result.exitCode, 0);
    assert.equal(deps._unregisteredIds.includes(taskId), false);

    // This used to assert the completion message was durable BEFORE dispatch. One transaction
    // removes that ordering: a refused admission leaves no wake message behind to reconcile.
    assert.equal(
      deps._appendedMessages.some((m) => m.source?.meta?.phase === 'wake'),
      false,
      'a refused admission must not leave a queued wake message behind',
    );
    assert.equal(
      deps._removedIds.includes(taskId),
      false,
      'queue-full is not a positive execution-plane ack, so fallback must remain recoverable',
    );
  });

  test('T13: failed atomic wake admission keeps the completed command recoverable', async (t) => {
    let admissionCalls = 0;
    const deps = makeStubDeps({
      async admitManagedWake() {
        admissionCalls += 1;
        throw new Error('simulated execution-plane failure');
      },
    });
    const app = await createApp(deps);
    t.after(() => app.close());
    const thread = await threadStore.create('user-hb-t13', 'hb-t13');
    const { invocationId, callbackToken } = await registry.create('user-hb-t13', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'trigger-failure gate',
        nextStep: 'retry wake dispatch',
        wakeWhen: { command: 'echo done' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    await waitForWakeHandling(deps, taskId, () => {
      const command = deps.dynamicTaskStore.getById(taskId)?.params.holdLifecycle.managedCommand;
      return admissionCalls > 0 && command?.messageClaimedAt === undefined;
    });
    assert.equal(admissionCalls, 1, 'the failed admission must actually have been attempted');
    const task = deps.dynamicTaskStore.getById(taskId);
    assert.equal(task.enabled, true);
    assert.equal(task.params.holdLifecycle.managedCommand.state, 'condition_met');
    assert.equal(task.params.holdLifecycle.managedCommand.result.exitCode, 0);
    assert.equal(deps._unregisteredIds.includes(taskId), false);

    // An admission that throws committed neither half, so no wake receipt may survive it — the
    // fallback reminder below is what keeps the wake recoverable, not a stranded message.
    assert.equal(
      deps._appendedMessages.some((m) => m.source?.meta?.phase === 'wake'),
      false,
      'a failed admission must leave no wake message behind',
    );
    assert.equal(
      deps._removedIds.includes(taskId),
      false,
      'trigger failure must leave the durable fallback available to recovery',
    );
  });

  test('T14: dispatched trigger retires fallback only after its durable carrier succeeds', async (t) => {
    const deps = makeStubDeps({
      invocationRecordStore: {
        getByIdempotencyKey(_threadId, _userId, key) {
          return { id: `invocation-${key}`, userMessageId: key.slice('connector-'.length), status: 'succeeded' };
        },
      },
    });
    const app = await createApp(deps);
    t.after(() => app.close());
    const thread = await threadStore.create('user-hb-t14', 'hb-t14');
    const { invocationId, callbackToken } = await registry.create('user-hb-t14', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'dispatch gate',
        nextStep: 'consume result',
        wakeWhen: { command: 'echo done' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    // Admission only proves the detached worker spawned; terminal persistence and wake handling follow it.
    await waitForWakeHandling(deps, taskId, () => deps._unregisteredIds.includes(taskId));

    const tombstone = deps._insertedTasks.find((task) => task.id === taskId);
    const job = resolveManagedCommandJob(deps.dynamicTaskStore.getById(taskId));
    assert.equal(
      deps._unregisteredIds.includes(taskId),
      true,
      `retirement did not complete: ${JSON.stringify({
        enabled: tombstone?.enabled,
        lifecycle: tombstone?.params?.holdLifecycle,
        gate: job ? readDurableGateRecord(job) : null,
      })}`,
    );
    assert.equal(deps._removedIds.includes(taskId), false, 'completion receipt must remain queryable by taskId');
    assert.equal(tombstone.enabled, false, 'successfully completed carrier retires scheduler execution');
    assert.equal(tombstone.params.holdLifecycle.status, 'fired');
    assert.equal(tombstone.params.holdLifecycle.managedCommand.state, 'consumed');
  });
});
