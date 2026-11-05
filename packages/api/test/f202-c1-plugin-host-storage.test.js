import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisPluginPrivateStorage } from '../dist/domains/plugin/host-surface/plugin-private-storage.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { FakeStorageRedis } from './helpers/fake-plugin-storage-redis.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const roots = [];

test('Host authority records remain separate even when a plugin chooses the same namespace and key', async () => {
  const redis = new FakeStorageRedis();
  const ordinary = new RedisPluginPrivateStorage(redis);
  const authority = new RedisPluginPrivateStorage(redis, 'host-member-sessions:v1');
  await authority.set('grants', 'same-key', { grantedBy: 'actual-owner-operation' });
  await ordinary.set('grants', 'same-key', { grantedBy: 'plugin-input' });
  assert.deepEqual((await authority.get('grants', 'same-key')).value, { grantedBy: 'actual-owner-operation' });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function writeStorageFixture(pluginId, capabilities = ['plugin.state.get', 'plugin.state.set']) {
  const root = await tempRoot('cat-cafe-f202-storage-package-');
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: `Storage fixture ${pluginId}`,
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        capabilities,
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(root, 'dist/plugin.js'),
    [
      'export default {',
      '  create() {',
      '    return {',
      '      start(host) {',
      '        return {',
      '          actions: {',
      "            'fixture.storage': async ({ operation, key, value, expectedRevision }) => {",
      "              if (operation === 'get') return host.storage.get(key);",
      "              if (operation === 'list') return host.storage.list();",
      "              if (operation === 'set') return host.storage.set(key, value);",
      "              if (operation === 'delete') return host.storage.delete(key, expectedRevision);",
      '              return host.storage.compareAndSet(key, expectedRevision, value);',
      '            },',
      '          },',
      '          stop() {},',
      '        };',
      '      },',
      '    };',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

test('module plugins receive isolated persistent storage with revision-fenced compare-and-set', async (t) => {
  const projectRoot = await tempRoot('cat-cafe-f202-storage-project-');
  const redis = new FakeStorageRedis();
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    redis,
    contract: { manifestContractRange: '0.1.0', validateManifest },
  });
  t.after(() => runtime.shutdown('test-cleanup'));
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const first = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeStorageFixture('dev.clowder.storage-first') },
  });
  const second = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeStorageFixture('dev.clowder.storage-second') },
  });
  for (const installed of [first, second]) {
    const detail = (await composition.manager.get(installed.pluginId)).plugin;
    await composition.manager.setEnabled(installed.pluginId, {
      enabled: true,
      expectedRevision: detail.lifecycleRevision,
    });
  }

  const invoke = (pluginInstanceId, input) => runtime.supervisor.invoke(pluginInstanceId, 'fixture.storage', input);
  assert.deepEqual(await invoke(first.pluginInstanceId, { operation: 'set', key: 'cursor', value: { page: 1 } }), {
    revision: 1,
  });
  assert.deepEqual(await invoke(first.pluginInstanceId, { operation: 'get', key: 'cursor' }), {
    revision: 1,
    value: { page: 1 },
  });
  assert.equal(await invoke(second.pluginInstanceId, { operation: 'get', key: 'cursor' }), undefined);
  await assert.rejects(
    invoke(first.pluginInstanceId, {
      operation: 'compareAndSet',
      key: 'cursor',
      expectedRevision: 0,
      value: { page: 2 },
    }),
    /positive safe integer/,
  );
  assert.deepEqual(
    await invoke(first.pluginInstanceId, {
      operation: 'compareAndSet',
      key: 'cursor',
      expectedRevision: 1,
      value: { page: 2 },
    }),
    { applied: true, revision: 2 },
  );
  assert.deepEqual(await invoke(first.pluginInstanceId, { operation: 'list' }), {
    cursor: { revision: 2, value: { page: 2 } },
  });
  const initialDedupe = await invoke(first.pluginInstanceId, { operation: 'set', key: 'dedupe', value: 'seen' });
  assert.ok(initialDedupe.revision > 2);
  const deletedDedupe = await invoke(first.pluginInstanceId, {
    operation: 'delete',
    key: 'dedupe',
    expectedRevision: initialDedupe.revision,
  });
  assert.equal(deletedDedupe.deleted, true);
  assert.ok(deletedDedupe.revision > initialDedupe.revision);
  assert.equal(await invoke(first.pluginInstanceId, { operation: 'get', key: 'dedupe' }), undefined);
  assert.deepEqual(
    await invoke(first.pluginInstanceId, {
      operation: 'delete',
      key: 'dedupe',
      expectedRevision: initialDedupe.revision,
    }),
    { deleted: false },
  );
  const recreated = await invoke(first.pluginInstanceId, {
    operation: 'compareAndSet',
    key: 'dedupe',
    expectedRevision: null,
    value: 'again',
  });
  assert.equal(recreated.applied, true, 'a deleted key must once again satisfy the absent-key CAS');
  assert.ok(recreated.revision > deletedDedupe.revision, 'recreating a key must not reuse a pre-delete revision');
  assert.deepEqual(
    await invoke(first.pluginInstanceId, {
      operation: 'compareAndSet',
      key: 'dedupe',
      expectedRevision: initialDedupe.revision,
      value: 'stale overwrite',
    }),
    { applied: false },
  );
  assert.deepEqual(
    await invoke(first.pluginInstanceId, {
      operation: 'delete',
      key: 'dedupe',
      expectedRevision: initialDedupe.revision,
    }),
    { deleted: false },
  );
  assert.deepEqual(redis.ttlCommands, [], 'plugin state is persistent by default and must never gain an implicit TTL');
});

const REDIS_URL = process.env.REDIS_URL;

test(
  'Redis storage executes the production Lua while preserving JSON values byte-for-byte',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F202PluginPrivateStorage');
    const [{ createRedisClient }, { RedisPluginPrivateStorage }] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/plugin/host-surface/plugin-private-storage.js'),
    ]);
    const redis = createRedisClient({
      url: REDIS_URL,
      keyPrefix: `f202-plugin-private-storage-${process.pid}:`,
    });
    try {
      await redis.ping();
      const storage = new RedisPluginPrivateStorage(redis);
      const values = {
        array: [],
        nested: { bindings: [], n: 1 },
        maxSafe: { id: 9007199254740991 },
        snowflake: { snowflake: 1234567890123456 },
        floating: { x: 0.30000000000000004 },
      };
      const revisions = {};
      let previousRevision = 0;
      for (const [key, value] of Object.entries(values)) {
        const encoded = JSON.stringify(value);
        const written = await storage.set('dev.clowder.redis-fixture', key, value);
        assert.ok(written.revision > previousRevision);
        previousRevision = written.revision;
        revisions[key] = written.revision;
        assert.deepEqual(await storage.get('dev.clowder.redis-fixture', key), { revision: written.revision, value });
        const raw = await redis.hget('plugin-private-state:v1:dev.clowder.redis-fixture', key);
        assert.equal(raw, `${written.revision}:v:${encoded}`, `${key} must remain byte-identical after Lua execution`);
      }
      const deleted = await storage.delete('dev.clowder.redis-fixture', 'nested', revisions.nested);
      assert.equal(deleted.deleted, true);
      assert.ok(deleted.revision > 1);
      assert.deepEqual(deleted, { deleted: true, revision: deleted.revision });
      assert.equal(await storage.get('dev.clowder.redis-fixture', 'nested'), undefined);
      assert.equal('nested' in (await storage.list('dev.clowder.redis-fixture')), false);
      const recreated = await storage.compareAndSet('dev.clowder.redis-fixture', 'nested', null, values.nested);
      assert.equal(recreated.applied, true, 'a deleted key must once again satisfy the absent-key CAS');
      assert.ok(recreated.revision > deleted.revision, 'recreating a key must use a fresh revision');
      assert.deepEqual(
        await storage.compareAndSet('dev.clowder.redis-fixture', 'nested', revisions.nested, { stale: true }),
        { applied: false },
      );
      assert.deepEqual(await storage.delete('dev.clowder.redis-fixture', 'nested', revisions.nested), {
        deleted: false,
      });

      const physicalHash = 'plugin-private-state:v1:dev.clowder.redis-fixture';
      for (let index = 0; index < 200; index += 1) {
        const key = `deleted-${index}`;
        const write = await storage.compareAndSet('dev.clowder.redis-fixture', key, null, { index });
        assert.equal(write.applied, true);
        assert.equal((await storage.delete('dev.clowder.redis-fixture', key, write.revision)).deleted, true);
      }
      assert.equal(
        await redis.hlen(physicalHash),
        Object.keys(values).length + 1,
        'deleted fields must be physically released; only live values and one revision counter remain',
      );

      const selectedKey = 'literal[*?].root';
      const selected = await storage.set('dev.clowder.redis-fixture', selectedKey, { selected: true });
      await storage.set('dev.clowder.redis-fixture', 'literalX.root', { unrelatedPrefix: true });
      await storage.set('dev.clowder.redis-fixture', 'literal[*?].history', { unrelatedSuffix: true });
      let cursor = '0';
      const pages = {};
      do {
        const page = await storage.scan('dev.clowder.redis-fixture', {
          prefix: 'literal[*?]',
          suffix: '.root',
          cursor,
          count: 1,
        });
        Object.assign(pages, page.entries);
        cursor = page.cursor;
      } while (cursor !== '0');
      assert.deepEqual(pages, { [selectedKey]: { revision: selected.revision, value: { selected: true } } });
      assert.equal(await redis.ttl(physicalHash), -1, 'paged reads must preserve persistent storage');
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
