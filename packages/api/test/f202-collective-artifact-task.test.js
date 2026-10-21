/** Exact Collective archive → real Host thread/message reads and Task data services.
 * OAuth/Cat liveness and message sending are test seams; no model or real account runs.
 * The package's Service, Connector, Work caller and result reconciliation are unmodified.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { F232PreparedArtifactReader } from '../dist/domains/growing/F232PreparedArtifactReader.js';
import { createPluginMessagingHost } from '../dist/domains/plugin/host-surface/plugin-messaging-host.js';
import { createPluginThreadHost } from '../dist/domains/plugin/host-surface/plugin-thread-host.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/task/plugin-task-host.js';
import {
  loadCollectiveModule as load,
  collectivePackageRoot as packageRoot,
} from './helpers/f202-collective-installed-business.js';
import { collectiveServiceFixture } from './helpers/f202-collective-service-fixture.js';

const matrixPath = process.env.F202_CANDIDATE_MATRIX;
test(
  'frozen Collective Work creates, attaches and closes one real Host Task; absent grant refuses mutations',
  {
    skip: !matrixPath && process.env.F202_ARTIFACT_GATE_REQUIRED !== '1',
    timeout: 60000,
  },
  async (t) => {
    assert.ok(matrixPath, 'F202_CANDIDATE_MATRIX required');
    const [service, connectorModule, contracts, workModule, resultModule] = await Promise.all([
      load('business/service/index.js'),
      load('business/connector/connector.js'),
      load('business/contracts/index.js'),
      load('collective-message-work.js'),
      load('collective-owner-work-result.js'),
    ]);
    const messages = new MessageStore(),
      threads = new ThreadStore(),
      tasks = new TaskStore();
    const ownerUserId = 'local-owner',
      pluginInstanceId = 'installed-collective';
    const channel = threads.create(ownerUserId, 'Collective channel');
    const f = await collectiveServiceFixture({ ...service, ...connectorModule, ...contracts }, channel.id);
    t.after(() => f.close());
    await f.connector.adoptWorkPolicy(f.connection.connectionId, ownerUserId, f.policy.revision);
    const work = await f.connector.acceptWork(f.source, f.agent, f.input);
    await f.connector.sync(f.connection.connectionId);
    const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
    const deps = {
      pluginId: manifest.pluginId,
      pluginInstanceId,
      ownerUserId,
      effectiveGrants: ['task.read', 'task.write', 'task.admitEntrusted'],
      taskStore: tasks,
      threadStore: threads,
      readThreadStore: threads,
      assertCurrent: async () => {},
      artifactReader: new F232PreparedArtifactReader({ messages }),
      admission: { messageStore: messages, isCatAvailable: (id) => id === 'codex', assertCurrent: async () => {} },
    };
    const taskHost = createPluginTaskHost(deps);
    const denied = createPluginTaskHost({ ...deps, effectiveGrants: ['task.read', 'task.write'] });
    const reader = createPluginMessagingHost({
      ...deps,
      manifest,
      messageStore: messages,
      effectiveGrants: ['thread.readContent'],
      messaging: {},
    });
    const records = new Map();
    const sent = new Map();
    const context = {
      pluginInstanceId,
      tasks: denied,
      threads: createPluginThreadHost({
        ...deps,
        projectPath: f.root,
        effectiveGrants: ['thread.read', 'thread.list', 'thread.readContent', 'thread.write'],
        threadDeepLinkUrl: (id) => `https://fixture.invalid/thread/${id}`,
        cats: {
          getAllCatIds: () => ['codex'],
          getCatDisplayName: () => 'Codex',
          getCatAliases: () => [],
          isCatAvailable: () => true,
          getRegisteredServices: () => new Map([['codex', {}]]),
        },
      }),
      storage: {
        get: async (key) => structuredClone(records.get(key)),
        compareAndSet: async (key, expected, value) => {
          if ((records.get(key)?.revision ?? null) !== expected) return { applied: false };
          const revision = (expected ?? 0) + 1;
          records.set(key, { revision, value: structuredClone(value) });
          return { applied: true, revision };
        },
      },
      messaging: {
        get: reader.get,
        send: async (threadId, draft) => {
          if (sent.has(draft.idempotencyKey)) return sent.get(draft.idempotencyKey);
          const message = messages.append({
            userId: ownerUserId,
            threadId,
            from: { kind: 'plugin', instanceId: pluginInstanceId },
            content: draft.payload.elements.map((e) => e.payload.text ?? '').join('\n'),
            timestamp: Date.now(),
            extra: {
              pluginMessage: {
                instanceId: pluginInstanceId,
                revision: 1,
                provenance: draft.payload.provenance,
                elements: draft.payload.elements,
                appendOps: [],
                presentation: {
                  connector: 'collective',
                  label: 'Collective',
                  icon: 'message',
                  meta: draft.meta,
                  sender: draft.sender,
                },
              },
            },
          });
          const receipt = { messageId: message.id, threadId };
          sent.set(draft.idempotencyKey, receipt);
          return receipt;
        },
      },
    };
    const caller = workModule.createCollectiveMessageWorkCaller(f.connector, context);
    const subject = `collective-work:${f.connection.connectionId}:${work.workId}`;
    const send = () => caller.send(f.connection.connectionId, work.assignmentEventId, ownerUserId, async () => {});
    await assert.rejects(send(), /task.admitEntrusted/);
    assert.equal(tasks.getBySubject(subject), null);
    context.tasks = taskHost;
    const wake = await send();
    const task = await taskHost.get({ subjectKey: subject });
    assert.ok(task?.entrustedWork);
    assert.notEqual(task.threadId, channel.id);
    assert.equal(threads.get(task.threadId).parentThreadId, channel.id);
    assert.equal((await send()).messageId, wake.messageId);
    const action = {
      userId: ownerUserId,
      catId: 'codex',
      threadId: task.threadId,
      invocationId: f.agent.sessionRef,
      originTriggerMessageId: wake.messageId,
      ownerAuthProvenance: 'unknown',
      assertCurrent: async () => {},
    };
    const artifactRef = '/uploads/collective-report.md';
    messages.append({
      userId: ownerUserId,
      threadId: task.threadId,
      from: { kind: 'agent', catId: 'codex' },
      content: 'Report',
      timestamp: Date.now(),
      extra: { rich: { blocks: [{ kind: 'file', v: 1, id: 'report', fileName: 'report.md', url: artifactRef }] } },
    });
    await caller.withCurrentMessage(action, async (binding) => {
      context.tasks = denied;
      await assert.rejects(binding.registerArtifactRefs(binding.work.revision, [artifactRef]), /task.admitEntrusted/);
      context.tasks = taskHost;
      await binding.registerArtifactRefs(binding.work.revision, [artifactRef]);
      assert.deepEqual((await taskHost.get({ id: task.id })).entrustedWork.artifactRefs, [artifactRef]);
    });
    const operation = await caller.withCurrentMessage(action, async (binding) => {
      const execution = { revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId };
      const prepared = await f.connector.prepareReply(
        binding.source,
        binding.sourceRef,
        binding.resultKey,
        binding.work.revision,
        binding.work.resultRevision,
        execution,
      );
      await f.connector.submitReply(
        binding.source,
        binding.sourceRef,
        binding.resultKey,
        prepared.outboxId,
        'Ready for owner acceptance.',
        f.agent,
        undefined,
        binding.work.resultRevision,
        execution,
      );
      await f.connector.sync(f.connection.connectionId);
      return f.connector.prepareReply(
        binding.source,
        binding.sourceRef,
        binding.resultKey,
        binding.work.revision,
        binding.work.resultRevision,
        execution,
      );
    });
    const ready = await f.connector.readAssignedWork(f.connection.connectionId, work.workId);
    const accepted = await f.store.acceptCollectiveWorkResult(f.owner.sessionToken, {
      serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId,
      workId: work.workId,
      expectedRevision: ready.revision,
      resultEventId: operation.acceptedEventId,
      resultRevision: ready.resultRevision,
      requestId: 'accept-real-host-result',
    });
    const result = {
      serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId,
      workId: work.workId,
      workRevision: accepted.revision,
      assignmentEventId: ready.assignmentEventId,
      resultEventId: operation.acceptedEventId,
      resultRevision: ready.resultRevision,
    };
    const reconcile = () =>
      resultModule.reconcileCollectiveMessageWorkResult(
        f.connector,
        context,
        ownerUserId,
        f.connection.connectionId,
        result,
        async () => {},
      );
    context.tasks = denied;
    await assert.rejects(reconcile(), /task.admitEntrusted/);
    assert.notEqual((await taskHost.get({ id: task.id })).status, 'done');
    context.tasks = taskHost;
    assert.equal((await reconcile()).result, 'closed');
    assert.equal((await reconcile()).result, 'already_closed');
    const closed = await taskHost.get({ id: task.id });
    assert.equal(closed.status, 'done');
    assert.deepEqual(closed.entrustedWork.artifactRefs, [artifactRef]);
    assert.equal(tasks.listByThread(task.threadId).length, 1);
  },
);
