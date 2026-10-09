/**
 * Real Batch8 archives through Manager, materializer and module carrier.
 * Only external provider I/O is replaced. This proves installed-package lifecycle,
 * not yet removal of the old gateway from index.ts or real-account acceptance.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
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
import { archiveFileName, RELEASES } from './helpers/f202-connector-artifact-pins.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const archives = process.env.F202_W25PH_ARCHIVE_DIR;
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

for (const release of RELEASES) {
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
      const archive = join(archives, archiveFileName(release));
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
      const messages = createPublishingMessageStore(new MessageStore(), {
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
      const installed = await manager.install({ source: { kind: 'local-archive', path: archive } });
      const thread = threads.create('owner', 'Package delivery');
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
    },
  );
}
