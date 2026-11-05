import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { openAlphaBrowserSubscription } from '../../../../scripts/lib/alpha-browser-subscription.mjs';
import { withInvocationCredentials } from '../../../mcp-server/dist/tools/invocation-auth.js';
import { handleUpdateScheduledTaskParams } from '../../../mcp-server/dist/tools/schedule-parameter-tools.js';
import { ApprovalIngress } from '../../dist/domains/approval-hub/ApprovalIngress.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { ScheduleMutationProposalStore } from '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { createAlphaBrowserTemplate } from '../../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { sessionAuthPlugin, sessionRoute } from '../../dist/infrastructure/session-auth.js';
import { scheduleRoutes } from '../../dist/routes/schedule.js';
import { scheduleProposalDecisionRoutes } from '../../dist/routes/schedule-proposal-decision-routes.js';

const oid = (n) => n.toString(16).padStart(40, '0');

it('MCP callback → owner approval keeps Alpha identity/cursor and applies managed only to a future unbound revision', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'schedule-update-journey-'));
  const owner = 'parameter-journey-owner';
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const catId = Object.entries(catRegistry.getAllConfigs()).find(([, config]) => config.available !== false)?.[0];
  assert.ok(catId);
  const db = new Database(join(directory, 'memory.sqlite'));
  applyMigrations(db);
  const tasks = new DynamicTaskStore(db),
    proposals = new ScheduleMutationProposalStore(db);
  const messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = threads.create(owner, 'Alpha carrier update', 'default');
  const original = {
    id: 'dyn-existing-alpha-subscription',
    templateId: 'alpha-browser',
    trigger: { type: 'cron', expression: '*/5 * * * *' },
    params: { baselineSha: oid(1), guardianCatId: catId },
    display: { label: 'Alpha 浏览器回归', category: 'repo' },
    deliveryThreadId: thread.id,
    enabled: true,
    createdBy: catId,
    createdAt: '2026-11-05T00:00:00Z',
  };
  tasks.insert(original);
  const subscription = openAlphaBrowserSubscription({
    databasePath: join(directory, 'gate.sqlite'),
    subscriptionId: original.id,
    repoRoot: directory,
    baselineSha: oid(1),
    ownerPrincipal: `schedule:${owner}:${original.id}`,
    originTaskId: original.id,
  });
  subscription.enroll({
    subscribedAfterSha: oid(1),
    discoveredThroughSha: oid(3),
    revisions: [
      { headSha: oid(2), baseSha: oid(1) },
      { headSha: oid(3), baseSha: oid(2) },
    ],
  });
  const calls = [];
  let release, running;
  const template = createAlphaBrowserTemplate({
    repoRoot: directory,
    ownerUserId: owner,
    tasks: {},
    resolveCat: (value) => (value === catId ? catId : null),
    inspectMain: async () => ({
      targetSha: oid(3),
      databasePath: join(directory, 'gate.sqlite'),
      legacyLockPath: join(directory, 'gate.lock'),
    }),
    loadRuntime: async () => ({
      async runAlphaBrowserRevision(input) {
        calls.push({
          subscriptionId: input.subscriptionId,
          baselineSha: input.baselineSha,
          executionCarrier: input.executionCarrier,
        });
        subscription.claimExecutionCarrier(calls.length === 1 ? oid(2) : oid(3), input.executionCarrier);
        if (calls.length === 1)
          await new Promise((resolve) => {
            release = resolve;
          });
        return { status: 'idle' };
      },
      async alphaBrowserFailureTasks() {
        return [];
      },
    }),
  });
  const registry = new InvocationRegistry();
  const templateRegistry = { get: (id) => (id === template.templateId ? template : null), list: () => [template] };
  const runner = new TaskRunnerV2({
    logger: { info() {}, error() {} },
    ledger: new RunLedger(db),
    dynamicTaskStore: tasks,
  });
  runner.registerDynamic(template.createSpec(original.id, original), original.id);
  const socketManager = { emitToUser() {}, broadcastToRoom() {} };
  const app = Fastify();
  t.after(async () => {
    release?.();
    await running;
    runner.stop();
    await app.close();
    subscription.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  await app.register(scheduleRoutes, {
    taskRunner: runner,
    dynamicTaskStore: tasks,
    templateRegistry,
    registry,
    ownerUserId: owner,
    scheduleMutationProposalStore: proposals,
    approvalIngress: new ApprovalIngress({ messageStore: messages, socketManager }),
    threadStore: threads,
  });
  await app.register(scheduleProposalDecisionRoutes, {
    ownerUserId: owner,
    store: proposals,
    taskRunner: runner,
    templateRegistry,
    socketManager,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiUrl = `http://127.0.0.1:${app.server.address().port}`;
  const credentials = await registry.create(owner, catId, thread.id);
  running = runner.triggerNow(original.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].executionCarrier, 'fork');
  const revisionsBefore = subscription.list();
  const invoke = (paramsPatch, creds = credentials) =>
    withInvocationCredentials({ ...creds, apiUrl }, () =>
      handleUpdateScheduledTaskParams({
        taskId: original.id,
        paramsPatch,
        sourceThreadId: 'caller-cannot-redirect-publication',
      }),
    );
  assert.equal((await invoke('{"executionCarrier":"invalid"}')).isError, true);
  const foreign = await registry.create('different-owner', catId, 'foreign-thread');
  const denied = await invoke('{"executionCarrier":"managed"}', foreign);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /403/);
  assert.equal(proposals.listPending(owner).length, 0);
  const result = await invoke('{"executionCarrier":"managed"}');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const { proposalId } = JSON.parse(result.content[0].text);
  const pending = proposals.getById(proposalId);
  assert.equal(pending.publication.state, 'anchored');
  assert.equal(pending.publication.envelope.approvalCardRef.threadId, thread.id);
  assert.ok(await messages.getById(pending.publication.envelope.approvalCardRef.messageId));
  assert.deepEqual(tasks.getById(original.id), original, 'proposal must have zero scheduling effect');
  const session = await fetch(`${apiUrl}/api/session`);
  const sessionBody = await session.json();
  const decision = await fetch(`${apiUrl}/api/schedule-proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: { cookie: session.headers.get('set-cookie').split(';')[0], 'x-csrf-token': sessionBody.csrfToken },
  });
  assert.equal(decision.status, 200, await decision.text());
  assert.deepEqual(tasks.getById(original.id), {
    ...original,
    params: { ...original.params, executionCarrier: 'managed' },
  });
  assert.equal(subscription.cursor(), oid(3));
  assert.deepEqual(subscription.list(), revisionsBefore, 'configuration must not rewrite any enrolled revision');
  await runner.triggerNow(original.id);
  assert.equal(calls.length, 1, 'approval must not clear the in-flight run guard');
  release();
  await running;
  await runner.triggerNow(original.id);
  assert.deepEqual(
    calls.map((call) => call.executionCarrier),
    ['fork', 'managed'],
  );
  assert.ok(
    calls.every((call) => call.subscriptionId === original.id && call.baselineSha === original.params.baselineSha),
  );
  assert.deepEqual(
    subscription.list().map((revision) => revision.executionCarrier),
    ['fork', 'managed'],
  );
  assert.equal(subscription.cursor(), oid(3));
});
