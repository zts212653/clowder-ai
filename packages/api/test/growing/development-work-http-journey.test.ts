import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';
import { callbackPost } from '../../../mcp-server/src/tools/callback-tools.js';
import {
  handleDevelopmentReturn,
  handleReadDevelopmentReturn,
} from '../../../mcp-server/src/tools/development-return-tools.js';
import {
  handleDevelopmentWork,
  handleResolveDevelopmentWork,
} from '../../../mcp-server/src/tools/development-work-tools.js';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  deriveGrowingSourceMessageRevision,
  MessageStore,
} from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProposalStore } from '../../src/domains/cats/services/stores/ports/ProposalStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { EntrustedWorkOwnerReadService } from '../../src/domains/growing/EntrustedWorkOwnerReadService.js';
import { F232PreparedArtifactReader } from '../../src/domains/growing/F232PreparedArtifactReader.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { DevelopmentReturnService } from '../../src/infrastructure/scheduler/development-return/DevelopmentReturnService.js';
import { RunLedger } from '../../src/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.js';
import { registerCallbackAuthHook } from '../../src/routes/callback-auth-prehandler.js';
import { registerCallbackDevelopmentReturnRoutes } from '../../src/routes/callback-development-return-routes.js';
import { registerCallbackTaskRoutes } from '../../src/routes/callback-task-routes.js';
import { registerEntrustedWorkReadRoutes } from '../../src/routes/entrusted-work-read-routes.js';
import { createPersistedQueueFixture } from '../helpers/persisted-queue-fixture.js';

// Real socket/MCP/owner integration with explicitly synthetic authorization. This is not a B3/B7 human episode.
test('untimed development crosses MCP, HTTP, original Task, publication, return and fresh owner action', async (t) => {
  const app = Fastify(),
    db = new Database(':memory:');
  applyMigrations(db);
  const dir = await mkdtemp(join(tmpdir(), 'f310-http-journey-'));
  t.after(async () => {
    await app.close();
    db.close();
    await rm(dir, { recursive: true });
  });
  const envKeys = ['CAT_CAFE_CREDENTIAL_FILE', 'CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN'];
  const previous = envKeys.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  const registry = new InvocationRegistry(),
    messages = new MessageStore(),
    tasks = new TaskStore(),
    threads = new ThreadStore();
  const proposals = new InMemoryProposalStore();
  const root = fileURLToPath(new URL('../../../..', import.meta.url));
  const thread = threads.create('fixture-human', 'Isolated development contract', root);
  const useInvocation = async (threadId = thread.id) => {
    const auth = await registry.create('fixture-human', 'codex-sol', threadId);
    process.env.CAT_CAFE_INVOCATION_ID = auth.invocationId;
    process.env.CAT_CAFE_CALLBACK_TOKEN = auth.callbackToken;
  };
  const ownerRead = new EntrustedWorkOwnerReadService({
    tasks,
    producerCatalog: { listCurrentReceipts: async () => [] },
    artifactReader: new F232PreparedArtifactReader({ messages }),
  });
  registerCallbackAuthHook(app, registry);
  registerCallbackTaskRoutes(app, {
    taskStore: tasks,
    messageStore: messages,
    threadStore: threads,
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
  });
  await app.register(async (scope) =>
    registerEntrustedWorkReadRoutes(scope, { service: ownerRead, callbackRegistry: registry }),
  );
  const artifactRef = '/uploads/isolated-development-result.md';
  const artifactPath = join(dir, 'result.md');
  const body =
    '# Isolated development result\nThe original work identity is preserved across two authenticated invocations.\n';
  app.get(artifactRef, async (_req, reply) => reply.type('text/markdown').send(await readFile(artifactPath, 'utf8')));
  const decode = async (pending) => {
    const result = await pending;
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  let taskId = '',
    ownerActions = 0;
  const definitions = new DynamicTaskStore(db);
  const runner = new TaskRunnerV2({
    ledger: new RunLedger(db),
    dynamicTaskStore: definitions,
    logger: { info() {}, error() {} },
  });
  t.after(() => runner.stop());
  const transport = createPersistedQueueFixture(messages);
  t.after(() => transport.close());
  const delivery = {
    async deliver(input) {
      const result = await transport.delivery.deliver(input);
      if (result.state !== 'unavailable' && result.state !== 'conflict' && ownerActions === 0) {
        await useInvocation();
        const read = await decode(callbackPost('/api/callbacks/read-entrusted-work', { taskId }));
        assert.equal(read.ownerRead.preparedArtifact.artifactRef, artifactRef);
        const closed = await decode(
          callbackPost('/api/callbacks/close-entrusted-work', {
            taskId,
            expectedRevision: 3,
            closure: {
              state: 'satisfied',
              condition: 'Inspectable artifact and verified source identity',
              expectedSignal: 'verified',
              evidenceRefs: [artifactRef],
            },
          }),
        );
        assert.equal(closed.task.status, 'done');
        ownerActions++;
      }
      return result;
    },
  };
  const returns = new DevelopmentReturnService({
    emit() {},
    delivery,
    definitions,
    runner,
    tasks,
    threads,
    messages,
    proposals,
  });
  await registerCallbackDevelopmentReturnRoutes(app, { registry, service: returns });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.notEqual(new URL(url).port, '3001');
  assert.notEqual(new URL(url).port, '3002');
  process.env.CAT_CAFE_API_URL = url;
  await useInvocation();
  const human = (content: string) =>
    messages.append({
      userId: 'fixture-human',
      catId: null,
      threadId: thread.id,
      content,
      mentions: [],
      timestamp: Date.now(),
    });
  const source = human('继续 Phase B，完成已接受的这个开发工作。');
  const admission = (message) => ({
    basis: 'explicit_entrustment',
    sourceRefs: [`message:${message.id}`],
    idempotencyKey: message.id,
    intendedOutcome: 'Inspectable isolated development result',
  });
  const scope = {
    featureRef: 'feature:F310',
    phaseKey: 'B',
    acceptedRevision: '09df55f01b5a9f0c89962baff68a39e0df050a86',
  };
  const initial = {
    scope,
    admission: admission(source),
    sourceMessageRevision: deriveGrowingSourceMessageRevision(source),
  };
  const resolved = await decode(handleResolveDevelopmentWork(initial));
  assert.equal(resolved.scope.workUnitRef, 'feature-phase:F310:B');
  const admitted = await decode(
    handleDevelopmentWork({
      ...initial,
      action: 'admit',
      title: 'Isolated accepted development',
      closure: { condition: 'Inspectable artifact and verified source identity', expectedSignal: 'verified' },
    }),
  );
  taskId = admitted.task.id;
  await useInvocation();
  const continuation = human('接着做这个阶段，把材料交回来。');
  const resumed = await decode(
    handleDevelopmentWork({
      scope,
      action: 'resume',
      taskId,
      expectedRevision: 1,
      admission: admission(continuation),
      sourceMessageRevision: deriveGrowingSourceMessageRevision(continuation),
    }),
  );
  assert.equal(resumed.task.id, taskId);
  assert.equal(tasks.listByThread(thread.id).length, 1);
  await writeFile(artifactPath, body);
  messages.append({
    userId: 'fixture-human',
    catId: 'codex-sol',
    threadId: thread.id,
    content: 'Prepared isolated result',
    mentions: [],
    timestamp: Date.now(),
    extra: {
      rich: {
        blocks: [
          {
            kind: 'file',
            v: 1,
            id: 'published-output',
            fileName: 'isolated-development-result.md',
            url: artifactRef,
            mimeType: 'text/markdown',
          },
        ],
      },
    },
  });
  await decode(
    callbackPost('/api/callbacks/update-entrusted-work', {
      taskId,
      expectedRevision: 2,
      status: 'doing',
      artifactRefs: [artifactRef],
    }),
  );
  assert.equal(await (await fetch(`${url}${artifactRef}`)).text(), body);
  const scheduleResponse = await fetch(`${url}/api/entrusted-work/owner-reads`, {
    headers: { 'x-cat-cafe-user': 'fixture-human' },
  });
  assert.equal(scheduleResponse.status, 200);
  const schedule = (await scheduleResponse.json()).ownerReads;
  assert.equal(schedule.length, 1);
  const current = await decode(callbackPost('/api/callbacks/read-entrusted-work', { taskId, observedRevision: 3 }));
  assert.deepEqual(schedule[0], current.ownerRead);
  assert.equal(schedule[0].envelope.subjectRef, `task:work:${taskId}`);
  assert.equal(schedule[0].envelope.revision, 3);
  assert.equal(schedule[0].work.title, 'Isolated accepted development');
  assert.equal(schedule[0].brief.current.state, 'doing');
  assert.equal(schedule[0].preparedArtifact.artifactRef, artifactRef);
  assert.deepEqual(schedule[0].timeRefs, []);
  assert.deepEqual(schedule[0].attentionReceipts, []);
  assert.deepEqual(await ownerRead.listNeedsMeForOwner('fixture-human'), []);
  const proposal = proposals.create({
    sourceThreadId: thread.id,
    sourceInvocationId: 'fixture',
    sourceMessageId: source.id,
    sourceCatId: 'codex-sol',
    title: 'Isolated execution',
    reason: 'Authorized fixture',
    parentThreadId: thread.id,
    preferredCats: ['codex-sol'],
    projectPath: root,
    createdBy: 'fixture-human',
    reportingMode: 'final-only',
  });
  const child = threads.create('fixture-human', 'Execution', root, thread.id, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: thread.id,
    approvedBy: 'fixture-human',
    approvedAt: Date.now(),
  });
  proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'fixture-human' });
  proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
  const registration = await decode(
    handleDevelopmentReturn({
      action: 'register',
      taskId,
      expectedRevision: 3,
      executionThreadId: child.id,
      sourceActionRef: `message:${source.id}`,
      expectedSignal: 'terminal_report',
      slaUntil: Date.now() + 60000,
    }),
  );
  await useInvocation(child.id);
  const childView = await decode(handleReadDevelopmentReturn({ registrationId: registration.registrationId }));
  assert.equal(JSON.stringify(childView).includes(taskId), false);
  const denied = await callbackPost('/api/callbacks/read-entrusted-work', { taskId });
  assert.equal(denied.isError, true);
  const report = messages.append({
    userId: 'fixture-human',
    catId: 'codex-sol',
    threadId: child.id,
    content: 'Final isolated result, verified through HTTP',
    mentions: [],
    timestamp: Date.now(),
  });
  const returned = await decode(
    handleDevelopmentReturn({
      action: 'report',
      registrationId: registration.registrationId,
      report: { sourceMessageId: report.id, outcome: 'completed', evidenceRefs: [artifactRef] },
    }),
  );
  assert.equal(returned.status, 'delivered');
  assert.equal(ownerActions, 1);
  assert.equal(tasks.get(taskId).entrustedWork.revision, 4);
  assert.equal(tasks.get(taskId).entrustedWork.admission.sourceRefs[0], `message:${source.id}`);
  assert.deepEqual(await ownerRead.listForOwner('fixture-human'), []);
  const historyResponse = await fetch(`${url}/api/entrusted-work/owner-reads?view=completed`, {
    headers: { 'x-cat-cafe-user': 'fixture-human' },
  });
  assert.equal(historyResponse.status, 200);
  const history = (await historyResponse.json()).ownerReads;
  assert.equal(history.length, 1);
  const completed = await decode(
    callbackPost('/api/callbacks/read-entrusted-work', { taskId, observedRevision: 4, includeCompleted: true }),
  );
  assert.deepEqual(history[0], completed.ownerRead);
  assert.equal(history[0].envelope.subjectRef, schedule[0].envelope.subjectRef);
  assert.equal(history[0].brief.current.state, 'done');
  assert.deepEqual(history[0].preparedArtifact, schedule[0].preparedArtifact);
  assert.deepEqual(history[0].attentionReceipts, []);
});
