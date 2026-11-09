import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { FilePluginSharedExtensionStore, MemoryPluginSharedExtensionStore, PluginSharedExtensionService } = await import(
  process.env.CAT_CAFE_TEST_SOURCE === '1'
    ? '../src/domains/plugin/shared-extension/plugin-shared-extension.ts'
    : '../dist/domains/plugin/shared-extension/plugin-shared-extension.js'
);

const manifest = {
  pluginId: 'official.chatgpt-dot',
  version: '1.0.0',
  contractVersion: '0.3.1-candidate.0',
  name: 'Fixture',
  configuration: [
    {
      key: 'connection',
      label: 'Connection',
      kind: 'operation',
      required: false,
      actions: [
        { id: 'begin', label: 'Prepare', render: 'button', resultRender: 'rows', action: { method: 'fixture.begin' } },
        {
          id: 'bind-shared',
          label: 'Connect',
          render: 'row',
          confirm: 'Connect this installation?',
          action: { method: 'fixture.bind' },
        },
      ],
    },
  ],
  runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
};

function fixture(options = {}) {
  let description = 'Read the approved fixture';
  let beforeReply = async () => {};
  let ownerKeyActive = true;
  let principalAvailable = options.principalAvailable !== false;
  let endpointAvailable = options.publicEndpoint !== false;
  const calls = [];
  const instance = {
    pluginInstanceId: 'pi_fixture',
    pluginId: 'official.chatgpt-dot',
    packageDigest: 'a'.repeat(64),
    lifecycleState: 'installed',
    configReadiness: 'ready',
    activationState: 'enabled',
    runtimeState: 'healthy',
    lifecycleRevision: 4,
    installedAt: 1,
    updatedAt: 1,
  };
  const packageRecord = {
    packageDigest: instance.packageDigest,
    pluginId: instance.pluginId,
    version: '1.0.0',
    contractVersion: '0.3.1-candidate.0',
    manifest,
    signalSchemas: {},
    provenance: { kind: 'catalog', catalogId: 'official', packageName: '@clowder-ai/fixture' },
    packageState: 'installed',
    verifiedAt: 1,
    updatedAt: 1,
  };
  const store = new MemoryPluginSharedExtensionStore();
  const service = new PluginSharedExtensionService({
    store,
    inventory: { snapshot: async () => ({ schemaVersion: 1, instances: [instance], packages: [packageRecord] }) },
    keys: {
      verify: async (secret) =>
        secret === 'owner-key' && ownerKeyActive
          ? { ok: true, record: { catId: 'gpt-pro', userId: 'owner' } }
          : secret === 'other-key'
            ? { ok: true, record: { catId: 'gpt-pro', userId: 'other' } }
            : { ok: false, reason: 'not_found' },
      list: async () => (principalAvailable ? [{ catId: 'gpt-pro', userId: 'owner', revokedAt: null }] : []),
    },
    publicEndpoint: () => (endpointAvailable ? 'https://shared.example/mcp' : undefined),
    handle: async (_instanceId, request) => {
      calls.push(request);
      const rpc = request.body;
      await beforeReply(rpc);
      const result =
        rpc.method === 'tools/list'
          ? { resultType: 'complete', tools: [{ name: 'fixture_read', description, inputSchema: { type: 'object' } }] }
          : rpc.method === 'events/list'
            ? { resultType: 'complete', events: [{ name: 'fixture.changed', argumentsSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'ok' }], isError: false };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { jsonrpc: '2.0', id: rpc.id, result },
      };
    },
    now: options.now ?? (() => 1_000),
    generateRef: options.generateRef ?? (() => 'proposal-one'),
  });
  return {
    service,
    store,
    instance,
    packageRecord,
    calls,
    drift: () => (description = 'Expanded fixture'),
    restoreSurface: () => (description = 'Read the approved fixture'),
    beforeReply: (next) => (beforeReply = next),
    revokeOwnerKey: () => (ownerKeyActive = false),
    removePrincipal: () => (principalAvailable = false),
    removeEndpoint: () => (endpointAvailable = false),
  };
}

test('verified legacy migration adopts the existing shared connection without exposing a new credential', async () => {
  const f = fixture();
  const adopted = await f.service.adoptVerifiedLegacy({
    instanceId: 'pi_fixture',
    expectedPackageDigest: f.packageRecord.packageDigest,
    ownerUserId: 'owner',
    evidenceRef: 'legacy-dot:old-instance:old-key',
  });
  assert.equal(adopted.binding.state, 'active');
  assert.equal(Object.hasOwn(adopted, 'token'), false);
  assert.equal(
    (await f.service.handle('owner-key', { jsonrpc: '2.0', id: 10, method: 'tools/list' })).result.tools[0].name,
    'fixture_read',
  );
});

test('a malformed persistent binding fails closed instead of becoming authorization', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-extension-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'shared.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, bindings: [{ state: 'active' }], proposals: [] }));
  await assert.rejects(() => new FilePluginSharedExtensionStore(path).snapshot(), /Invalid shared extension store/);
});

for (const reason of ['disabled', 'runtime', 'key', 'package', 'surface', 'other-plugin'])
  test(`legacy shared compatibility rejects ${reason} changes`, async () => {
    const f = fixture();
    const adopt = () =>
      f.service.adoptVerifiedLegacy({
        instanceId: 'pi_fixture',
        expectedPackageDigest: f.packageRecord.packageDigest,
        ownerUserId: 'owner',
        evidenceRef: 'legacy-dot:old-instance:old-key',
      });
    if (reason === 'other-plugin') {
      f.packageRecord.pluginId = 'official.another';
      await assert.rejects(adopt(), /legacy_dot_installation_required/);
      return;
    }
    await adopt();
    if (reason === 'disabled') f.instance.activationState = 'disabled';
    if (reason === 'runtime') f.instance.runtimeState = 'stopped';
    if (reason === 'key') f.revokeOwnerKey();
    if (reason === 'package') f.packageRecord.packageDigest = 'new-digest';
    if (reason === 'surface') f.drift();
    await assert.rejects(() =>
      f.service.handle('owner-key', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_read' } }),
    );
  });
test('legacy adoption never exposes the removed generic binding operations', async () => {
  const f = fixture();
  for (const name of ['prepare', 'bind', 'unbind', 'validatePresentation']) assert.equal(f.service[name], undefined);
});

function adoption(f, extra = {}) {
  return {
    instanceId: f.instance.pluginInstanceId,
    expectedPackageDigest: f.packageRecord.packageDigest,
    ownerUserId: 'owner',
    evidenceRef: 'legacy-dot:old-instance:old-key',
    ...extra,
  };
}

test('same installation update recovers the original approved surface without reauthorizing it', async () => {
  const f = fixture();
  await f.service.adoptVerifiedLegacy(adoption(f));
  f.instance.packageDigest = f.packageRecord.packageDigest = 'b'.repeat(64);
  f.instance.lifecycleRevision++;
  await f.service.adoptVerifiedLegacy(adoption(f));
  await f.service.handle('owner-key', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  f.drift();
  await assert.rejects(f.service.adoptVerifiedLegacy(adoption(f)), /shared_surface_changed/);
  assert.equal((await f.store.snapshot()).bindings[0].state, 'needs-confirmation');
  f.restoreSurface();
  assert.equal((await f.service.adoptVerifiedLegacy(adoption(f))).binding.state, 'active');
  await f.service.handle('owner-key', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
});

for (const reason of [
  'instance',
  'owner',
  'lineage',
  'revoked',
  'expired-request',
  'late-binding',
  'late-runtime',
  'late-principal',
])
  test(`verified recovery cannot revive or replace ${reason}`, async () => {
    const f = fixture();
    await f.service.adoptVerifiedLegacy(adoption(f));
    const original = (await f.store.snapshot()).bindings[0];
    if (reason === 'instance') f.instance.pluginInstanceId = 'replacement';
    if (reason === 'lineage') f.packageRecord.provenance.catalogId = 'other';
    if (reason === 'revoked')
      await f.store.update((state) => ({
        state: { ...state, bindings: [{ ...original, state: 'revoked', revision: original.revision + 1 }] },
        result: undefined,
      }));
    let current = true;
    let changed = false;
    f.beforeReply(async () => {
      if (reason === 'expired-request') current = false;
      if (reason === 'late-runtime') f.instance.lifecycleRevision++;
      if (reason === 'late-principal') f.removePrincipal();
      if (reason === 'late-binding' && !changed) {
        changed = true;
        await f.store.update((state) => ({
          state: { ...state, bindings: [{ ...original, state: 'revoked', revision: original.revision + 1 }] },
          result: undefined,
        }));
      }
    });
    const run = () =>
      f.service.adoptVerifiedLegacy(
        adoption(f, {
          ownerUserId: reason === 'owner' ? 'other' : 'owner',
          assertCurrent: () => {
            if (!current) throw Error('owner request expired');
          },
        }),
      );
    if (['owner', 'late-principal'].includes(reason)) assert.equal(await run(), null);
    else if (reason === 'revoked') assert.equal((await run()).binding.state, 'revoked');
    else await assert.rejects(run());
    const latest = (await f.store.snapshot()).bindings[0];
    assert.equal(latest.instanceId, original.instanceId);
    assert.equal(latest.state, ['revoked', 'late-binding'].includes(reason) ? 'revoked' : 'active');
    assert.equal(latest.approvedSurfaceDigest, original.approvedSurfaceDigest);
  });

test('durable legacy audit recovers shared MCP after a same-instance package update without reimport', async (t) => {
  const from = (path) =>
    import(
      process.env.CAT_CAFE_TEST_SOURCE === '1'
        ? `../src/domains/plugin/migration/${path}.ts`
        : `../dist/domains/plugin/migration/${path}.js`
    );
  const { FileDotLegacyMigrationAuditStore } = await from('dot-legacy-migration-audit-store');
  const { DotLegacyMigrationJourney } = await from('dot-legacy-migration-journey');
  const { DotLegacyMigrationCoordinator } = await from('dot-legacy-migration-coordinator');
  const directory = await mkdtemp(join(tmpdir(), 'shared-recovery-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture();
  const audit = new FileDotLegacyMigrationAuditStore(join(directory, 'audit.json'));
  const prior = {
    version: 1,
    ownerUserId: 'owner',
    sourceInstanceId: 'old-dot',
    pluginInstanceId: f.instance.pluginInstanceId,
    packageDigest: f.packageRecord.packageDigest,
    authority: { active: true, agentKeyId: 'old-key' },
    receipts: [],
    media: [],
    sourceDeleted: false,
    completedAt: 1,
  };
  await audit.save(prior);
  await f.service.adoptVerifiedLegacy(adoption(f));
  const never = async () => {
    throw Error('must not reimport legacy keys');
  };
  const source = { connection: async () => ({ ownerUserId: 'owner', pluginInstanceId: 'old-dot' }) };
  const coordinator = new DotLegacyMigrationCoordinator({
    source,
    keys: { get: never },
    invoker: { invoke: never },
    media: { register: never },
    audit,
    externalAccess: { adopt: never },
    sharedExtension: f.service,
  });
  const journey = new DotLegacyMigrationJourney({ source, audit, coordinator });
  f.instance.packageDigest = f.packageRecord.packageDigest = 'b'.repeat(64);
  f.instance.lifecycleRevision++;
  const current = {
    pluginId: f.instance.pluginId,
    pluginInstanceId: f.instance.pluginInstanceId,
    packageDigest: f.instance.packageDigest,
    ownerUserId: 'owner',
    requestId: 'owner-update',
    signal: new AbortController().signal,
    assertCurrent() {},
  };
  await journey.ensure(current);
  await journey.afterEnable(current);
  await f.service.handle('owner-key', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(Object.values((await audit.read()).records), [prior], 'no new migration or credential import');
});
