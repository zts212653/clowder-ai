/**
 * Exact task296 candidate archives through Manager, materializer and module carrier.
 * Only external provider I/O is replaced. This proves installed-package lifecycle,
 * permission copy and selected command parity, not real-account acceptance or old-code removal.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import {
  InstalledPluginOperations,
  pluginOperationRoutes,
} from '../dist/domains/plugin/operations/plugin-operation-routes.js';
import { copyLegacyConnectorPermissions } from '../scripts/f202-legacy-permission-copy.mjs';

const exec = promisify(execFile);
const matrixPath = process.env.F202_CANDIDATE_MATRIX;
const matrix = matrixPath ? JSON.parse(await readFile(matrixPath, 'utf8')) : { selfContained: [] };
const candidateReleases = matrix.selfContained.map((row) => ({
  ...row,
  name: row.name.replace('@clowder-ai/connector-', ''),
  sha: row.sha256,
}));
const sourceKind = process.env.F202_CANDIDATE_SOURCE ?? 'local-archive';
assert.ok(['local-archive', 'local-directory', 'git'].includes(sourceKind), 'unsupported candidate source');
if (!matrixPath) {
  test('task296 candidate matrix is supplied', { skip: process.env.F202_ARTIFACT_GATE_REQUIRED !== '1' }, () => {
    assert.fail('F202_CANDIDATE_MATRIX is required for the mandatory artifact gate');
  });
} else {
  assert.equal(candidateReleases.length, 7, 'the exact seven-package candidate must be exercised');
}

import { pathToFileURL } from 'node:url';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createPublishingMessageStore } from '../dist/domains/messaging/publishing-message-store.js';
import { createMessagingStores } from '../dist/domains/messaging/stores/factory.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { FilesystemBuiltinPluginPackageMaterializer } from '../dist/domains/plugin/manager/builtin-package-materializer.js';
import { resolveLocalPluginEffectiveGrants } from '../dist/domains/plugin/manager/machine-catalog-provider.js';
import { OFFICIAL_PLUGIN_HOST_POLICIES } from '../dist/domains/plugin/manager/official-plugin-host-policies.js';
import { resolvePluginRuntimePersistencePaths } from '../dist/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const archives = matrixPath;
const required = process.env.F202_ARTIFACT_GATE_REQUIRED === '1';
const adapterNames = {
  telegram: 'TelegramAdapter',
  feishu: 'FeishuAdapter',
  dingtalk: 'DingTalkAdapter',
  'wecom-agent': 'WeComAgentAdapter',
  'wecom-bot': 'WeComBotAdapter',
  weixin: 'WeixinAdapter',
  xiaoyi: 'XiaoyiAdapter',
};
const values = {
  botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
  encodingAesKey: 'A'.repeat(43),
  connectionMode: 'webhook',
  appId: 'fixture-app',
  appKey: 'fixture-key',
  appSecret: 'fixture-secret',
  verificationToken: 'fixture-verification',
  corpId: 'fixture-corp',
  agentId: '1',
  agentSecret: 'fixture-secret',
  callbackToken: 'fixture-token',
  botId: 'fixture-bot',
  botSecret: 'fixture-secret',
  secret: 'fixture-secret',
  accessKey: 'fixture-ak',
  secretKey: 'fixture-sk',
};

for (const release of candidateReleases) {
  test(
    `${release.name}: actual package activation is exclusive and disable/re-enable disposes the prior instance`,
    {
      skip: !required && (!archives || redisIsolationSkipReason(process.env.REDIS_URL)),
      timeout: 60000,
    },
    async (t) => {
      assert.ok(archives, 'mandatory production gate requires archives');
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f202-w24-production');
      assert.equal(redisIsolationSkipReason(process.env.REDIS_URL), false);
      const archive = release.archive;
      assert.equal(
        createHash('sha256')
          .update(await readFile(archive))
          .digest('hex'),
        release.sha,
      );
      const root = await mkdtemp('/tmp/f202-w24-production-');
      const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `w24-${root.split('/').at(-1)}:` });
      const threads = new ThreadStore();
      const bindings = new MemoryConnectorThreadBindingStore();
      const stores = createMessagingStores(redis);
      const failures = [];
      const messageStore = new MessageStore();
      const messages = createPublishingMessageStore(messageStore, {
        events: stores.events,
        publications: stores.publications,
        onPublishFailure: (error) => failures.push(error),
      });
      const outbound = [];
      const materializer = new FilesystemBuiltinPluginPackageMaterializer({
        packagesRoot: resolvePluginRuntimePersistencePaths(root).packagesRoot,
      });
      let starts = 0,
        stops = 0,
        live = 0,
        maximumLive = 0;
      const start = ModulePluginRuntime.prototype.start;
      const stop = ModulePluginRuntime.prototype.stop;
      const activeInstances = new Set();
      t.mock.method(ModulePluginRuntime.prototype, 'start', async function (...args) {
        await start.apply(this, args);
        starts += 1;
        live += 1;
        maximumLive = Math.max(maximumLive, live);
        activeInstances.add(args[0]);
      });
      t.mock.method(ModulePluginRuntime.prototype, 'stop', async function (...args) {
        await stop.apply(this, args);
        if (activeInstances.delete(args[0])) {
          live -= 1;
          stops += 1;
        }
      });
      // No real provider endpoints are contacted, including Feishu identity lookup.
      t.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            JSON.stringify({
              code: 0,
              tenant_access_token: 'fixture-token',
              expire: 7200,
              bot: { open_id: 'fixture-bot' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );
      const runtime = createDormantPluginRuntimeComposition({
        projectRoot: root,
        redis,
        routes: new MemorySignalRouteStore(),
        intakes: new MemoryMeetingIntakeStore(),
        messageStore: messages,
        messagingStores: stores,
        threadStore: threads,
        threadBindingStore: bindings,
        threadOwnerUserId: 'owner',
        threadDeepLinkUrl: (id) => `https://cafe.example.test/thread/${encodeURIComponent(id)}`,
        threadProjections: {
          cats: {
            getAllCatIds: () => ['opus'],
            getCatDisplayName: () => 'Opus',
            getCatAliases: () => ['@opus'],
            isCatAvailable: () => true,
            getRegisteredServices: () => new Map([['opus', {}]]),
          },
        },
        builtinPackages: {
          async resolve(input) {
            const located = await materializer.resolve(input);
            const name = adapterNames[release.name];
            const { [name]: Adapter } = await import(pathToFileURL(join(located.rootDir, 'dist', `${name}.js`)).href);
            for (const method of ['startPolling', 'stopPolling', 'startStream', 'stopStream']) {
              if (typeof Adapter.prototype[method] === 'function')
                t.mock.method(Adapter.prototype, method, async () => undefined);
            }
            for (const method of ['sendReply', 'sendRichMessage', 'sendFormattedReply']) {
              if (typeof Adapter.prototype[method] === 'function') {
                t.mock.method(Adapter.prototype, method, async (...args) => {
                  outbound.push({ method, args });
                });
              }
            }
            return located;
          },
        },
      });
      t.after(async () => {
        await runtime.shutdown('test');
        await redis.quit();
      });
      const { manager, configuration } = createPluginManagerRuntimeComposition({
        runtime,
        catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
        catalogManifests: [],
        localGrantPolicy: (manifest) => resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, manifest),
      });
      let source = { kind: 'local-archive', path: archive };
      let sourceCommit = null;
      if (sourceKind !== 'local-archive') {
        const sourceRoot = await mkdtemp('/tmp/f202-candidate-source-');
        await exec('tar', ['-xzf', archive, '-C', sourceRoot]);
        const directory = join(sourceRoot, 'package');
        source = { kind: 'local-directory', path: directory };
        if (sourceKind === 'git') {
          await exec('git', ['init', '--quiet', directory]);
          await exec('git', ['-C', directory, 'add', '--force', '--', '.']);
          await exec('git', [
            '-C',
            directory,
            '-c',
            'user.name=C1 acceptance',
            '-c',
            'user.email=c1@example.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '-m',
            'Exact candidate archive for isolated Git admission',
          ]);
          sourceCommit = (await exec('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
          source = { kind: 'git', url: pathToFileURL(directory).href };
        }
      }
      const installed = await manager.install({ source });
      const thread = threads.create('owner', 'Package delivery');
      await messageStore.append({
        threadId: thread.id,
        userId: 'owner',
        catId: 'opus',
        content: 'History parity needle',
        mentions: [],
        timestamp: 1,
      });
      bindings.bind(installed.pluginId, 'external-chat', thread.id, 'owner');
      let detail = (await manager.get(installed.pluginId)).plugin;
      const updates = detail.configFields
        .filter((field) => field.kind !== 'operation' && (field.required || Object.hasOwn(values, field.key)))
        .map((field) => ({
          key: field.key,
          value: values[field.key] ?? (field.kind === 'boolean' ? 'false' : 'fixture-value'),
        }));
      if (updates.length)
        await configuration.configure(installed.pluginId, installed.pluginInstanceId, {
          expectedRevision: detail.configRevision ?? detail.lifecycleRevision,
          updates,
        });
      await configuration.reconcile(installed.pluginId, installed.pluginInstanceId);
      detail = (await manager.get(installed.pluginId)).plugin;
      await manager.setEnabled(installed.pluginId, { enabled: true, expectedRevision: detail.lifecycleRevision });
      detail = (await manager.get(installed.pluginId)).plugin;
      assert.equal(detail.live, 'running', JSON.stringify(detail.diagnostic));
      assert.equal(starts, 1);
      const operations = new InstalledPluginOperations({
        inventory: runtime.inventoryStore,
        configuration,
        invocation: runtime.supervisor,
      });
      const legacyId = release.name === 'wecom-agent' ? 'wecom' : release.name;
      const config = { whitelistEnabled: 'false', commandAdminOnly: 'false', adminOpenIds: '[]' };
      const groups = { 'external-chat': JSON.stringify({ label: 'Fixture group', addedAt: 12 }) };
      await redis.hset(`connector-perm:${legacyId}`, config);
      await redis.hset(`connector-perm-groups:${legacyId}`, groups);
      const app = Fastify();
      app.decorateRequest('sessionUserId', undefined);
      app.addHook('onRequest', async (request) => {
        request.sessionUserId = request.headers['x-test-session'];
      });
      await app.register(pluginOperationRoutes, { operations });
      app.post('/isolated-copy', async (request, reply) => {
        const result = await copyLegacyConnectorPermissions({
          request,
          redis,
          operations,
          connectorId: legacyId,
          target: { pluginId: installed.pluginId, operationKey: 'legacy_permissions', actionId: 'import' },
        });
        return reply.status(result.status).send(result.body);
      });
      t.after(() => app.close());
      const headers = {
        host: 'localhost:4999',
        origin: 'http://localhost:4999',
        'x-test-session': process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner',
      };
      const copy = async (payload = { confirmed: true }, requestHeaders = headers) =>
        app.inject({ method: 'POST', url: '/isolated-copy', headers: requestHeaders, payload });
      assert.equal(
        (await copy({ confirmed: true, owner: true }, { host: headers.host, origin: headers.origin })).statusCode,
        401,
      );
      assert.equal((await copy({ confirmed: false })).statusCode, 400);
      const first = await copy();
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().data.status, 'imported');
      assert.equal((await copy()).json().data.status, 'already_applied');
      if (release.name === 'feishu') {
        const beforeCommands = outbound.length;
        const invokeCommand = async (text, id) =>
          runtime.supervisor.invoke(installed.pluginInstanceId, 'feishu.webhook', {
            request: {
              method: 'POST',
              path: 'feishu/events',
              body: {
                schema: '2.0',
                header: { event_id: id, event_type: 'im.message.receive_v1', token: 'fixture-verification' },
                event: {
                  sender: { sender_id: { open_id: 'fixture-owner' } },
                  message: {
                    message_id: id,
                    chat_id: 'external-chat',
                    chat_type: 'p2p',
                    message_type: 'text',
                    content: JSON.stringify({ text }),
                  },
                },
              },
            },
          });
        const where = await invokeCommand('/where', 'where-1');
        assert.equal(where.status, 200, JSON.stringify(where));
        assert.ok(JSON.stringify(outbound.at(-1)).includes(`https://cafe.example.test/thread/${thread.id}`));
        const history = await invokeCommand('/history 1', 'history-1');
        assert.equal(history.status, 200, JSON.stringify(history));
        assert.ok(
          JSON.stringify(outbound.at(-1)).includes('History parity needle'),
          'history returns actual Host content via its declared grant',
        );
        const target = threads.create('owner', 'Archived-Needle');
        target.lastActiveAt = 1;
        for (let i = 0; i < 51; i++) {
          const recent = threads.create('owner', `Recent ${i}`);
          recent.lastActiveAt = 100 + i;
        }
        const use = await invokeCommand('/use Archived-Needle', 'use-51');
        assert.equal(use.status, 200, JSON.stringify(use));
        assert.equal((await bindings.getByExternal(installed.pluginId, 'external-chat')).threadId, target.id);
        await invokeCommand(`/use ${thread.id}`, 'use-restore');
        assert.equal((await bindings.getByExternal(installed.pluginId, 'external-chat')).threadId, thread.id);
        outbound.splice(beforeCommands);
      }
      const call = async (operation, action, payload = {}) =>
        app.inject({
          method: 'POST',
          url: `/api/plugins/${installed.pluginId}/actions/${operation}/${action}`,
          headers,
          payload,
        });
      const read = await call('connector_permissions', 'read');
      assert.equal(read.statusCode, 200, read.body);
      const applied = await call('connector_permissions_apply', 'configure', { permissionCommandAdminOnly: 'true' });
      assert.equal(applied.statusCode, 200, applied.body);
      assert.equal(applied.json().data.status, 'configured');
      assert.equal((await copy()).json().data.status, 'preserved_existing');
      assert.deepEqual(await redis.hgetall(`connector-perm:${legacyId}`), config);
      assert.deepEqual(await redis.hgetall(`connector-perm-groups:${legacyId}`), groups);
      assert.ok(!JSON.stringify(first.json()).includes('external-chat'), 'receipt contains no group ID');
      assert.deepEqual(runtime.subscriptionDelivery.subscribersForThread(thread.id), [installed.pluginInstanceId]);
      await messages.append({
        threadId: thread.id,
        userId: 'owner',
        catId: 'opus',
        content: 'one package reply',
        mentions: [],
        timestamp: Date.now(),
      });
      await runtime.subscriptionDelivery.drain(thread.id);
      assert.deepEqual(failures, []);
      assert.equal(outbound.length, 1, 'one Host message reaches one real package outbound action');
      assert.equal(outbound[0].args[0], 'external-chat');
      assert.ok(JSON.stringify(outbound[0].args).includes('one package reply'));
      await manager.setEnabled(installed.pluginId, { enabled: true, expectedRevision: detail.lifecycleRevision });
      assert.equal(starts, 1, 'enabling an enabled instance cannot create a second runtime');
      detail = (await manager.get(installed.pluginId)).plugin;
      await manager.setEnabled(installed.pluginId, { enabled: false, expectedRevision: detail.lifecycleRevision });
      assert.equal(live, 0);
      assert.equal(stops, 1);
      assert.deepEqual(runtime.subscriptionDelivery.subscribersForThread(thread.id), []);
      await messages.append({
        threadId: thread.id,
        userId: 'owner',
        catId: 'opus',
        content: 'while disabled',
        mentions: [],
        timestamp: Date.now(),
      });
      await runtime.subscriptionDelivery.drain(thread.id);
      assert.equal(outbound.length, 1, 'disabled package receives no new outbound delivery');
      detail = (await manager.get(installed.pluginId)).plugin;
      await manager.setEnabled(installed.pluginId, { enabled: true, expectedRevision: detail.lifecycleRevision });
      assert.equal(starts, 2);
      assert.equal(maximumLive, 1);
      assert.deepEqual(runtime.subscriptionDelivery.subscribersForThread(thread.id), [installed.pluginInstanceId]);
      await runtime.shutdown('test');
      assert.equal(live, 0);
      assert.equal(stops, 2);
      await writeFile(
        join(process.env.F202_CANDIDATE_EVIDENCE, `${sourceKind}-${release.name}.json`),
        `${JSON.stringify(
          {
            pass: true,
            sourceKind,
            source,
            sourceCommit,
            archive,
            sha256: release.sha,
            root,
            starts,
            stops,
            maximumLive,
            permissionReceipt: first.json(),
            ownerEditsPreserved: true,
            legacyKeysRetained: true,
            sdk: matrix.canonical.find((row) => row.name === '@clowder-ai/plugin-sdk').sha256,
          },
          null,
          2,
        )}\n`,
      );
    },
  );
}
