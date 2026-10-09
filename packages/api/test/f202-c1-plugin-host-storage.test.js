import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeStorageRedis {
  hashes = new Map();
  ttlCommands = [];

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async eval(script, _keyCount, key, field, expectedRevision, value) {
    const hash = this.hashes.get(key) ?? new Map();
    const currentRaw = hash.get(field);
    const match = currentRaw?.match(/^(\d+):([vd]):(.*)$/s);
    const currentRevision = match === undefined || match === null ? null : Number(match[1]);
    const currentKind = match?.[2];
    if (script.includes('plugin-private-storage:delete-v1')) {
      return this.applyDelete(hash, key, field, currentRevision, currentKind, expectedRevision);
    }
    if (expectedRevision !== '*') {
      const expected = expectedRevision === '' ? null : Number(expectedRevision);
      if (currentRevision !== expected) return 0;
    }
    const revision = Number(hash.get('') ?? 0) + 1;
    hash.set('', String(revision));
    hash.set(field, `${revision}:v:${value}`);
    this.hashes.set(key, hash);
    return revision;
  }

  applyDelete(hash, key, field, currentRevision, currentKind, expectedRevision) {
    if (currentRevision === null || currentKind !== 'v') return 0;
    if (expectedRevision !== '*' && currentRevision !== Number(expectedRevision)) return 0;
    const revision = Number(hash.get('') ?? 0) + 1;
    hash.set('', String(revision));
    hash.delete(field);
    this.hashes.set(key, hash);
    return revision;
  }

  async expire(...args) {
    this.ttlCommands.push(['expire', ...args]);
    return 1;
  }

  async pexpire(...args) {
    this.ttlCommands.push(['pexpire', ...args]);
    return 1;
  }
}

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

test('module plugins receive isolated persistent storage with revision-fenced compare-and-set', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-storage-project-');
  const redis = new FakeStorageRedis();
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    redis,
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: (manifest) => manifest.features.flatMap((feature) => feature.capabilities),
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
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);

test('module plugin storage fails closed when the package lacks the matching grant', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-storage-grant-project-');
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    redis: new FakeStorageRedis(),
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: () => [],
  });
  const installed = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeStorageFixture('dev.clowder.storage-ungranted', []) },
  });
  const detail = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: detail.lifecycleRevision,
  });

  await assert.rejects(
    runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.storage', {
      operation: 'get',
      key: 'cursor',
    }),
    /lacks plugin\.state\.get/,
  );
  await assert.rejects(
    runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.storage', {
      operation: 'set',
      key: 'cursor',
      value: 1,
    }),
    /lacks plugin\.state\.set/,
  );
  await assert.rejects(
    runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.storage', {
      operation: 'delete',
      key: 'cursor',
    }),
    /lacks plugin\.state\.set/,
  );
});
