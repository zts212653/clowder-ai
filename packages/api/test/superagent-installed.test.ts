import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { z } from 'zod';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../src/domains/cats/services/stores/redis/RedisTaskStore.js';
import { RedisThreadStore } from '../src/domains/cats/services/stores/redis/RedisThreadStore.js';
import { createPublishingMessageStore } from '../src/domains/messaging/publishing-message-store.js';
import { createMessagingStores } from '../src/domains/messaging/stores/factory.js';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import {
  listPluginConversations,
  openPluginConversation,
} from '../src/domains/plugin/declared/plugin-conversations.js';
import { createPluginConversationDelivery } from '../src/domains/plugin/host-surface/plugin-conversation-delivery.js';
import {
  InstalledPluginOperations,
  pluginOperationRoutes,
} from '../src/domains/plugin/operations/plugin-operation-routes.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../src/domains/plugin/runtime-composition.js';
import type { TaskSpec_P1 } from '../src/infrastructure/scheduler/types.js';
import { assertRedisIsolationOrThrow } from './helpers/redis-test-helpers.js';
import { assertSuperagentHostFailure } from './helpers/superagent-host-failure.js';
import './helpers/setup-cat-registry.js';

const archive = process.env.SUPERAGENT_ARCHIVE_PATH;
const inspected = z.object({
  inbox: z.array(
    z.object({ delivery: z.object({ deliveryId: z.string(), envelope: z.object({ messageId: z.string() }) }) }),
  ),
});
const view = z.object({ threadId: z.string(), status: z.string(), badgeCount: z.number() });

test(
  'packed Superagent installs, selects scope, admits parallel Work, follows across restart and returns a result through real Host ports',
  { skip: !archive, timeout: 120_000 },
  async (t) => {
    assert.ok(archive);
    const redisUrl = process.env.SUPERAGENT_TEST_REDIS_URL ?? process.env.REDIS_URL;
    assert.ok(redisUrl, 'run with the isolated Redis runner or the Windows probe');
    if (process.env.SUPERAGENT_WINDOWS_PROBE_LEDGER) {
      const ledger = z
        .object({ pid: z.number().int().positive(), port: z.literal(6417), dataDirectory: z.string(), url: z.string() })
        .parse(JSON.parse(await readFile(process.env.SUPERAGENT_WINDOWS_PROBE_LEDGER, 'utf8')));
      assert.equal(process.platform, 'win32');
      assert.equal(ledger.url, redisUrl);
      assert.ok(ledger.dataDirectory.includes('superagent-installed-'));
      const evidence = JSON.parse(
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$env:SUPERAGENT_PROBE_VERIFY_PID); $c = Get-NetTCPConnection -LocalPort 6417 -State Listen; @{ pid=$p.ProcessId; command=$p.CommandLine; listener=$c.OwningProcess } | ConvertTo-Json -Compress',
          ],
          { encoding: 'utf8', env: { ...process.env, SUPERAGENT_PROBE_VERIFY_PID: String(ledger.pid) } },
        ),
      );
      assert.equal(evidence.pid, ledger.pid);
      assert.equal(evidence.listener, ledger.pid);
      assert.ok(evidence.command.includes(ledger.dataDirectory), 'Redis must be this probe own data directory');
      assert.equal(new URL(redisUrl).pathname, '/15');
    } else assertRedisIsolationOrThrow(redisUrl, 'superagent-installed');
    const redis = new Redis(redisUrl);
    const root = await mkdtemp(join(tmpdir(), 'superagent-installed-'));
    const owner = 'default-user';
    const stores = createMessagingStores(redis);
    const messages = createPublishingMessageStore(new RedisMessageStore(redis, { ttlSeconds: 0 }), {
      events: stores.events,
      publications: stores.publications,
      onPublishFailure(error) {
        throw error;
      },
    });
    const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const tasks = new RedisTaskStore(redis, { ttlSeconds: 0 });
    const agents = new AgentRegistry();
    for (const catId of ['codex', 'opus'])
      agents.register(catId, {
        async *invoke() {
          throw new Error('This journey verifies Host orchestration, not provider IO');
        },
      });
    const router = new AgentRouter({
      agentRegistry: agents,
      registry: new InvocationRegistry(),
      messageStore: messages,
      threadStore: threads,
    });
    const queue = new InvocationQueue(new RedisQueueLedgerStore(redis));
    const invocation = createPluginConversationDelivery({ messageStore: messages, queue, router });
    let capabilities: CapabilitiesConfig | null = null;
    const scheduled = new Map<string, TaskSpec_P1>();
    const createRuntime = () =>
      createDormantPluginRuntimeComposition({
        projectRoot: root,
        capabilityProjectRoot: root,
        redis,
        messageStore: messages,
        threadStore: threads,
        taskStore: tasks,
        threadOwnerUserId: owner,
        messagingStores: stores,
        invokeTrigger: invocation,
        taskRunner: {
          registerPostStart: (task) => {
            scheduled.set(task.id, task);
          },
          unregister: (id) => scheduled.delete(id),
        },
        members: {
          listCats: () =>
            ['codex', 'opus'].map((catId) => ({ catId, displayName: catId, defaultModel: 'not-invoked' })),
          isCatAvailable: () => true,
          publicAvatar: async () => undefined,
        },
        threadProjections: {
          cats: {
            getAllCatIds: () => ['codex', 'opus'],
            getCatDisplayName: (id) => id,
            getCatAliases: (id) => [`@${id}`],
            isCatAvailable: () => true,
            getRegisteredServices: () => agents.getAllEntries(),
          },
        },
        mcpConfigIO: {
          readConfig: async () => capabilities,
          writeAndRegenCli: async (value) => {
            capabilities = value;
          },
          withLock: async (run) => run(),
        },
      });
    let runtime = createRuntime();
    const manager = () =>
      createPluginManagerRuntimeComposition({
        runtime,
        catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: Date.now() }) },
        catalogManifests: [],
      });
    let composition = manager();
    const bytes = await readFile(archive);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const installed = await composition.manager.install({
      source: { kind: 'local-archive', path: archive },
      expectedDigest: integrity,
    });
    const id = installed.pluginId;
    const instance = installed.pluginInstanceId;
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await runtime.shutdown('test_cleanup');
      await redis.quit();
    });
    const first = await threads.create(owner, '选定的开发会话', root);
    const second = await threads.create(owner, '选定的评审会话', root);
    const outside = await threads.create(owner, '未选会话', root);
    const entries = () =>
      listPluginConversations({ inventory: runtime.inventoryStore, runtime: runtime.supervisor, threads }, owner);
    assert.equal((await entries()).length, 1, 'the tgz supplies an installed top entry before activation');
    let detail = (await composition.manager.get(id)).plugin;
    await composition.manager.configure(id, {
      expectedRevision: detail.lifecycleRevision,
      updates: [{ key: 'responsibility', value: '跟进本样例的导出修复和发布说明；产品决定与验收找我。' }],
    });
    detail = (await composition.manager.get(id)).plugin;
    await composition.manager.setEnabled(id, { enabled: true, expectedRevision: detail.lifecycleRevision });
    const operations = new InstalledPluginOperations({
      inventory: runtime.inventoryStore,
      configuration: composition.configuration,
      invocation: runtime.supervisor,
      settingsInvocation: runtime.settingsInvocation,
    });
    app.decorateRequest('sessionUserId', undefined);
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = owner;
      request.assertSessionCurrent = () => {};
    });
    await app.register(pluginOperationRoutes, { operations });
    const operation = async (
      field: string,
      action: string,
      payload: Record<string, unknown> = {},
      confirmed = false,
    ) => {
      const result = await app.inject({
        method: 'POST',
        url: `/api/plugins/${id}/actions/${field}/${action}`,
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost:5173',
          origin: 'http://localhost:5173',
          ...(confirmed ? { 'x-cat-cafe-owner-confirmed': 'true' } : {}),
        },
        payload,
      });
      assert.equal(result.statusCode, 200, result.payload);
      return result;
    };
    await operation('scope', 'list');
    await operation('scope', 'choose', { selection: 'coordinator', id: 'codex' });
    await operation('scope', 'choose', { selection: 'worker', id: 'opus' });
    await operation('scope', 'choose', { selection: 'thread', id: first.id });
    await operation('scope', 'choose', { selection: 'thread', id: second.id });
    await operation('activity', 'enable', {}, true);
    const main = view.parse(await runtime.supervisor.invoke(instance, 'superagent.view', {}));
    assert.equal(main.status, 'listening');
    const bound = await openPluginConversation(
      { inventory: runtime.inventoryStore, runtime: runtime.supervisor, threads },
      owner,
      instance,
      'conversation',
    );
    assert.equal(bound.threadId, main.threadId, 'an explicit owner open binds the actual installed plugin main thread');
    assert.equal((await entries())[0].threadId, main.threadId, 'ordinary list reads use the durable Host binding');
    const native = (threadId: string, catId = 'codex') => ({
      catId,
      threadId,
      userId: owner,
      invocationId: `scripted-${threadId}`,
      ownerAuthProvenance: 'unknown' as const,
      assertCurrent: async () => {},
    });
    const call = (method: string, input: unknown, threadId = main.threadId, catId = 'codex') =>
      withPluginCallContext(instance, native(threadId, catId), () =>
        runtime.supervisor.invoke(instance, method, input),
      );
    const tick = async () => {
      const task = scheduled.get('plugin:official.superagent:schedule:reconcile');
      assert.ok(task, 'the installed manifest must register its real scheduler callback');
      await task.run.execute({}, 'reconcile', {
        occurrenceId: 'scripted-clock',
        signal: new AbortController().signal,
        assignedCatId: null,
      });
    };
    const say = async (threadId: string, content: string) => {
      const message = await messages.append({
        threadId,
        userId: owner,
        from: { kind: 'user', userId: owner },
        content,
        mentions: [],
        timestamp: Date.now(),
      });
      await runtime.subscriptionDelivery.drain(threadId);
      return message;
    };
    await say(outside.id, '这条未选范围不得触发模型。');
    await tick();
    assert.equal(inspected.parse(await call('superagent.inspect', {})).inbox.length, 0);
    const source = await say(first.id, '请修复导出，并准备发布说明。');
    await tick();
    let inbox = inspected.parse(await call('superagent.inspect', {})).inbox;
    const incoming = inbox.find((row) => row.delivery.envelope.messageId === source.id);
    assert.ok(incoming);
    await call('superagent.route', {
      eventId: incoming.delivery.deliveryId,
      decisions: [
        { kind: 'start', title: '导出修复', outcome: '修复并验证导出', workerId: 'opus' },
        { kind: 'start', title: '发布说明', outcome: '准备可审阅发布说明', workerId: 'opus' },
      ],
    });
    await tick();
    const works = await tasks.listByKind('work');
    assert.equal(works.length, 2);
    const work = works.find((row) => row.title === '导出修复');
    assert.ok(work);
    assert.notEqual(work.threadId, main.threadId);
    assert.equal(work.ownerCatId, 'opus');
    assert.ok(work.entrustedWork?.admission.sourceRefs[0].startsWith('message:'));
    await assertSuperagentHostFailure(runtime, first.id, {
      messages,
      tasks,
      work,
      tick,
      pause: () => operation('pause', 'pause'),
    });
    await operation('activity', 'enable', {}, true);
    await runtime.shutdown('host_restart');
    runtime = createRuntime();
    composition = manager();
    await runtime.supervisor.start(instance);
    assert.equal(view.parse(await runtime.supervisor.invoke(instance, 'superagent.view', {})).threadId, main.threadId);
    assert.equal(
      (await entries())[0].threadId,
      main.threadId,
      'the Host instance binding survives process composition restart',
    );
    const feedback = await say(second.id, '导出修复还漏了空文件，请沿原事项补上。');
    await tick();
    inbox = inspected.parse(await call('superagent.inspect', {})).inbox;
    const follow = inbox.find((row) => row.delivery.envelope.messageId === feedback.id);
    assert.ok(follow);
    await call('superagent.route', {
      eventId: follow.delivery.deliveryId,
      decisions: [{ kind: 'follow_up', workId: work.id, content: '补上空文件，并重新验证。' }],
    });
    await tick();
    assert.equal((await tasks.listByKind('work')).length, 2);
    assert.equal((await tasks.get(work.id))?.threadId, work.threadId);
    await call(
      'superagent.report',
      { workId: work.id, reportId: 'result', kind: 'result', content: '样例交付：空文件场景已验证。' },
      work.threadId,
      'opus',
    );
    await tick();
    const original = await messages.getByThread(first.id, 50, owner);
    assert.equal(original.filter((row) => row.content.includes('样例交付')).length, 1);
    assert.equal((await tasks.get(work.id))?.entrustedWork?.closure.state, 'open');
    const accepted = await say(second.id, '这个导出结果验收通过。');
    await tick();
    inbox = inspected.parse(await call('superagent.inspect', {})).inbox;
    const acceptance = inbox.find((row) => row.delivery.envelope.messageId === accepted.id);
    assert.ok(acceptance);
    await call('superagent.route', {
      eventId: acceptance.delivery.deliveryId,
      decisions: [{ kind: 'accept', workId: work.id }],
    });
    await tick();
    assert.equal((await tasks.get(work.id))?.entrustedWork?.closure.state, 'satisfied');
    const record = {
      kind: 'installed-real-host-scripted-members',
      archive,
      integrity,
      root,
      mainThreadId: main.threadId,
      workIds: works.map((row) => row.id),
      sourceRefs: [source.id, feedback.id, accepted.id],
      verified: [
        'tgz-install',
        'owner-settings',
        'selected-scope',
        'canonical-work',
        'ordinary-queue-wake',
        'host-restart',
        'cross-thread-feedback',
        'original-source-delivery',
        'owner-acceptance',
        'host-failure-message-correlation',
      ],
      notVerified: ['real-model-judgment', 'real-code-execution', 'browser', 'macOS'],
    };
    const evidence = process.env.SUPERAGENT_EVIDENCE_DIR ?? root;
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'installed-host-probe.json'), JSON.stringify(record, null, 2));
  },
);
