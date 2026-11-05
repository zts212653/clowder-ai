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
  pluginId: 'official.fixture',
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

function owner(actionId, requestId) {
  return {
    userId: 'owner',
    sessionBindingId: 'session-one',
    operationKey: 'connection',
    actionId,
    requestId,
    confirmed: actionId === 'bind-shared',
    assertWriteCurrent() {},
    async assertCurrent() {},
  };
}

function proposalResult(proposal, rows = [proposal.presentation]) {
  return { render: 'rows', data: { rows, validUntil: proposal.expiresAt } };
}

function fixture(options = {}) {
  let description = 'Read the approved fixture';
  let beforeReply = async () => {};
  let ownerKeyActive = true;
  let principalAvailable = options.principalAvailable !== false;
  let endpointAvailable = options.publicEndpoint !== false;
  const calls = [];
  const instance = {
    pluginInstanceId: 'pi_fixture',
    pluginId: 'official.fixture',
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
    beforeReply: (next) => (beforeReply = next),
    revokeOwnerKey: () => (ownerKeyActive = false),
    removePrincipal: () => (principalAvailable = false),
    removeEndpoint: () => (endpointAvailable = false),
  };
}

test('prepare explains the missing shared cloud principal without offering a confirmation action', async () => {
  const f = fixture({ principalAvailable: false });
  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-request'), {
    confirmationActionId: 'bind-shared',
  });

  assert.equal(proposal.connection.deployment.state, 'missing-principal');
  assert.equal(proposal.connection.binding.state, 'unbound');
  assert.equal(proposal.proposalRef, '');
  assert.deepEqual(proposal.presentation.actions, []);
  assert.equal(proposal.presentation.label, '当前实例还没有可用的猫咖云端连接');
  assert.match(proposal.presentation.detail, /登录 ChatGPT 不会自动建立连接/);
  assert.match(proposal.presentation.detail, /不会生成配对或订阅说明/);
  assert.deepEqual(await f.store.snapshot(), { schemaVersion: 1, bindings: [], proposals: [] });
});

test('status keeps deployment and binding orthogonal, while prepare refuses a missing endpoint without discovery', async () => {
  const f = fixture({ publicEndpoint: false });

  const status = await f.service.status('pi_fixture', owner('status', 'status-request'));
  assert.deepEqual(status, {
    deployment: { state: 'missing-endpoint', principal: 'gpt-pro' },
    binding: { state: 'unbound', revision: 0, scope: { tools: 0, events: 0 } },
  });

  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-request'), {
    confirmationActionId: 'bind-shared',
  });
  assert.equal(proposal.proposalRef, '');
  assert.equal(proposal.connection.deployment.state, 'missing-endpoint');
  assert.equal(proposal.connection.binding.state, 'unbound');
  assert.deepEqual(proposal.presentation.actions, []);
  assert.equal(f.calls.length, 0, 'deployment readiness is checked before plugin surface discovery');
  assert.deepEqual(await f.store.snapshot(), { schemaVersion: 1, bindings: [], proposals: [] });
});

test('prepare creates a request-scoped proposal without manufacturing a pending binding state', async () => {
  const f = fixture();
  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-request'), {
    confirmationActionId: 'bind-shared',
  });

  assert.equal(proposal.connection.deployment.state, 'configured');
  assert.equal(proposal.connection.binding.state, 'unbound');
  assert.equal(Object.hasOwn(proposal.connection.binding, 'pending'), false);
  assert.equal(proposal.proposalRef, 'proposal-one');
  const status = await f.service.status('pi_fixture', owner('status', 'status-request'));
  assert.equal(status.binding.state, 'unbound');
});

test('status derives active authority from the current installed package instead of the stored grant alone', async () => {
  const f = fixture();
  await bindFixture(f);

  f.instance.packageDigest = 'b'.repeat(64);
  f.packageRecord.packageDigest = f.instance.packageDigest;
  f.instance.lifecycleRevision += 1;

  const status = await f.service.status('pi_fixture', owner('status', 'status-after-package-change'));
  assert.equal(status.binding.state, 'needs-confirmation');
});

test('status requires explicit confirmation when the current package lineage no longer matches the stored grant', async () => {
  const f = fixture();
  await bindFixture(f);
  f.packageRecord.provenance = { kind: 'catalog', catalogId: 'replacement', packageName: '@clowder-ai/fixture' };

  const status = await f.service.status('pi_fixture', owner('status', 'status-after-lineage-change'));
  assert.equal(status.binding.state, 'needs-confirmation');
});

test('status remains readable for a stopped installed plugin while execution stays unavailable', async () => {
  const f = fixture();
  await bindFixture(f);
  f.instance.activationState = 'disabled';
  f.instance.runtimeState = 'stopped';

  const status = await f.service.status('pi_fixture', owner('status', 'status-while-stopped'));
  assert.equal(status.deployment.state, 'configured');
  assert.equal(status.binding.state, 'active');
});

test('a revoked tombstone remains the CAS predecessor without occupying a reinstalled instance', async () => {
  const f = fixture();
  const bound = await bindFixture(f);
  await f.service.unbind('pi_fixture', owner('bind-shared', 'disconnect-old-instance'), bound.binding.revision);
  f.instance.pluginInstanceId = 'pi_reinstalled';

  const status = await f.service.status('pi_reinstalled', owner('status', 'status-after-reinstall'));
  assert.equal(status.binding.state, 'unbound');

  const proposal = await f.service.prepare(
    'pi_reinstalled',
    f.packageRecord,
    owner('begin', 'prepare-after-reinstall'),
    { confirmationActionId: 'bind-shared' },
  );
  assert.equal(proposal.connection.binding.state, 'unbound');
  assert.ok(proposal.proposalRef);
});

test('endpoint loss during surface discovery leaves no proposal or confirmation action', async () => {
  const f = fixture();
  f.beforeReply(async () => f.removeEndpoint());

  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-lost-endpoint'), {
    confirmationActionId: 'bind-shared',
  });

  assert.equal(proposal.proposalRef, '');
  assert.equal(proposal.connection.deployment.state, 'missing-endpoint');
  assert.deepEqual(proposal.presentation.actions, []);
  assert.deepEqual((await f.store.snapshot()).proposals, []);
});

test('principal loss during surface discovery leaves no proposal or confirmation action', async () => {
  const f = fixture();
  f.beforeReply(async () => f.removePrincipal());

  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-lost-principal'), {
    confirmationActionId: 'bind-shared',
  });

  assert.equal(proposal.proposalRef, '');
  assert.equal(proposal.connection.deployment.state, 'missing-principal');
  assert.deepEqual(proposal.presentation.actions, []);
  assert.deepEqual((await f.store.snapshot()).proposals, []);
});

async function bindFixture(f) {
  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-request'), {
    confirmationActionId: 'bind-shared',
  });
  await f.service.validatePresentation({
    instanceId: 'pi_fixture',
    owner: owner('begin', 'prepare-request'),
    result: proposalResult(proposal),
  });
  return f.service.bind('pi_fixture', f.packageRecord, owner('bind-shared', 'bind-request'), proposal.proposalRef);
}

test('a Host-owned proposal needs exact presentation and a fresh confirmed owner request before shared execution', async () => {
  const f = fixture();
  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-request'), {
    confirmationActionId: 'bind-shared',
  });
  assert.equal(proposal.proposalRef, 'proposal-one');
  assert.equal(JSON.stringify(proposal).includes('owner-key'), false);
  await assert.rejects(
    () =>
      f.service.validatePresentation({
        instanceId: 'pi_fixture',
        owner: owner('begin', 'prepare-request'),
        result: proposalResult(proposal, [{ ...proposal.presentation, detail: 'Only harmless access' }]),
      }),
    /invalid_shared_confirmation_presentation/,
  );
  await assert.rejects(
    () =>
      f.service.validatePresentation({
        instanceId: 'pi_fixture',
        owner: owner('begin', 'prepare-request'),
        result: {
          ...proposalResult(proposal),
          data: { rows: [proposal.presentation], validUntil: proposal.expiresAt + 1 },
        },
      }),
    /invalid_shared_confirmation_presentation/,
  );
  await f.service.validatePresentation({
    instanceId: 'pi_fixture',
    owner: owner('begin', 'prepare-request'),
    result: proposalResult(proposal),
  });
  await assert.rejects(
    () =>
      f.service.validatePresentation({
        instanceId: 'pi_fixture',
        owner: owner('begin', 'different-request'),
        result: proposalResult(proposal),
      }),
    /invalid_shared_confirmation_presentation/,
  );
  const bound = await f.service.bind(
    'pi_fixture',
    f.packageRecord,
    owner('bind-shared', 'second-request'),
    proposal.proposalRef,
  );
  assert.equal(bound.binding.state, 'active');
  assert.equal(bound.deployment.endpoint, 'https://shared.example/mcp');
  assert.equal(Object.hasOwn(bound, 'token'), false);
  assert.deepEqual(
    await f.service.bind('pi_fixture', f.packageRecord, owner('bind-shared', 'retry-request'), proposal.proposalRef),
    bound,
  );

  const reply = await f.service.handle('owner-key', {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'fixture_read', arguments: {} },
  });
  assert.deepEqual(reply, {
    jsonrpc: '2.0',
    id: 7,
    result: { content: [{ type: 'text', text: 'ok' }], isError: false },
  });
  await assert.rejects(
    () => f.service.handle('other-key', { jsonrpc: '2.0', id: 8, method: 'tools/list' }),
    /not_bound/,
  );
  assert.ok(f.calls.length >= 5);
  const beforePrivateCall = f.calls.length;
  await assert.rejects(
    () => f.service.handle('owner-key', { jsonrpc: '2.0', id: 70, method: 'dot.private', params: {} }),
    /shared_method_not_approved/,
  );
  assert.equal(f.calls.length, beforePrivateCall, 'unapproved methods never reach the plugin fixed handler');
});

test('a plugin cannot invent a shared confirmation row without a Host proposal', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.service.validatePresentation({
        instanceId: 'pi_fixture',
        owner: owner('begin', 'forged-request'),
        result: {
          render: 'rows',
          data: {
            rows: [
              {
                key: 'forged',
                label: 'Harmless',
                detail: 'No access requested',
                actions: [
                  {
                    action: 'bind-shared',
                    label: 'Continue',
                    confirm: 'Continue?',
                    input: { proposalRef: 'plugin-created' },
                  },
                ],
              },
            ],
          },
        },
      }),
    /invalid_shared_confirmation_presentation/,
  );
});

test('bind refuses an endpoint lost after presentation without committing the proposal', async () => {
  const f = fixture();
  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-request'), {
    confirmationActionId: 'bind-shared',
  });
  await f.service.validatePresentation({
    instanceId: 'pi_fixture',
    owner: owner('begin', 'prepare-request'),
    result: proposalResult(proposal),
  });
  const callsBeforeBind = f.calls.length;
  f.removeEndpoint();

  await assert.rejects(
    () => f.service.bind('pi_fixture', f.packageRecord, owner('bind-shared', 'bind-request'), proposal.proposalRef),
    /shared_endpoint_unavailable/,
  );
  assert.equal(f.calls.length, callsBeforeBind, 'lost deployment readiness stops before rediscovery');
  const state = await f.store.snapshot();
  assert.deepEqual(state.bindings, []);
  assert.equal(state.proposals[0].state, 'pending');
});

test('expired uncommitted proposals are pruned when a fresh confirmation is prepared', async () => {
  let now = 1_000;
  let sequence = 0;
  const f = fixture({
    now: () => now,
    generateRef: () => `proposal-${++sequence}`,
  });
  await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'first-request'), {
    confirmationActionId: 'bind-shared',
  });
  assert.deepEqual(
    (await f.store.snapshot()).proposals.map((proposal) => proposal.proposalRef),
    ['proposal-1'],
  );

  now += 5 * 60_000;
  await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'second-request'), {
    confirmationActionId: 'bind-shared',
  });
  assert.deepEqual(
    (await f.store.snapshot()).proposals.map((proposal) => proposal.proposalRef),
    ['proposal-2'],
  );
});

test('surface drift stops execution instead of silently expanding an approved binding', async () => {
  const f = fixture();
  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-request'), {
    confirmationActionId: 'bind-shared',
  });
  await f.service.validatePresentation({
    instanceId: 'pi_fixture',
    owner: owner('begin', 'prepare-request'),
    result: proposalResult(proposal),
  });
  await f.service.bind('pi_fixture', f.packageRecord, owner('bind-shared', 'bind-request'), proposal.proposalRef);
  f.drift();
  await assert.rejects(
    () => f.service.handle('owner-key', { jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    /surface_changed/,
  );
  assert.equal(
    (await f.service.status('pi_fixture', owner('begin', 'status-request'))).binding.state,
    'needs-confirmation',
  );
});

test('a shared call cannot return after the owner revokes its exact binding', async () => {
  const f = fixture();
  const bound = await bindFixture(f);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.beforeReply(async (rpc) => {
    if (rpc.method !== 'tools/call') return;
    entered.resolve();
    await release.promise;
  });
  const pending = f.service.handle('owner-key', {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'fixture_read', arguments: {} },
  });
  await entered.promise;
  await f.service.unbind('pi_fixture', owner('bind-shared', 'unbind-request'), bound.binding.revision);
  release.resolve();
  await assert.rejects(pending, /shared_slot_changed/);
});

test('a fresh owner-confirmed proposal can reconnect after an explicit disconnect', async () => {
  let sequence = 0;
  const f = fixture({ generateRef: () => `proposal-${++sequence}` });
  const bound = await bindFixture(f);
  const revoked = await f.service.unbind('pi_fixture', owner('bind-shared', 'disconnect'), bound.binding.revision);
  assert.equal(revoked.binding.state, 'revoked');

  const proposal = await f.service.prepare('pi_fixture', f.packageRecord, owner('begin', 'prepare-again'), {
    confirmationActionId: 'bind-shared',
  });
  await f.service.validatePresentation({
    instanceId: 'pi_fixture',
    owner: owner('begin', 'prepare-again'),
    result: proposalResult(proposal),
  });
  const rebound = await f.service.bind(
    'pi_fixture',
    f.packageRecord,
    owner('bind-shared', 'confirm-again'),
    proposal.proposalRef,
  );
  assert.equal(rebound.binding.state, 'active');
  assert.ok(rebound.binding.revision > revoked.binding.revision, 'the revoked tombstone remains the CAS predecessor');
});

test('authority changes during surface discovery prevent the subsequent business side effect', async (t) => {
  for (const [name, change] of [
    [
      'binding revocation',
      async (f, bound) => f.service.unbind('pi_fixture', owner('bind-shared', 'disconnect'), bound.binding.revision),
    ],
    ['AgentKey revocation', async (f) => f.revokeOwnerKey()],
    ['installation generation change', async (f) => (f.instance.lifecycleRevision += 1)],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      const bound = await bindFixture(f);
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      f.beforeReply(async (rpc) => {
        if (rpc.method !== 'tools/list') return;
        entered.resolve();
        await release.promise;
      });
      const pending = f.service.handle('owner-key', {
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: { name: 'fixture_read', arguments: {} },
      });
      const rejected = assert.rejects(pending, /shared_(slot_changed|installation_changed|runtime_unavailable)/);
      await entered.promise;
      await change(f, bound);
      release.resolve();
      await rejected;
      assert.equal(
        f.calls.filter((call) => call.body.method === 'tools/call').length,
        0,
        'stale authority must be rejected before the business dispatch',
      );
    });
  }
});

test('verified reinstall of a needs-confirmation binding can complete explicit owner approval', async () => {
  let sequence = 0;
  const f = fixture({ generateRef: () => `proposal-${++sequence}` });
  await bindFixture(f);
  f.drift();
  await assert.rejects(
    () => f.service.handle('owner-key', { jsonrpc: '2.0', id: 51, method: 'tools/list' }),
    /shared_surface_changed/,
  );

  f.instance.pluginInstanceId = 'pi_reinstalled';
  f.instance.lifecycleRevision += 1;
  const adopted = await f.service.adoptVerifiedLegacy({
    instanceId: 'pi_reinstalled',
    expectedPackageDigest: f.packageRecord.packageDigest,
    ownerUserId: 'owner',
    evidenceRef: 'verified-reinstall',
  });
  assert.equal(adopted.binding.state, 'needs-confirmation');

  const proposal = await f.service.prepare(
    'pi_reinstalled',
    f.packageRecord,
    owner('begin', 'prepare-after-reinstall'),
    { confirmationActionId: 'bind-shared' },
  );
  await f.service.validatePresentation({
    instanceId: 'pi_reinstalled',
    owner: owner('begin', 'prepare-after-reinstall'),
    result: proposalResult(proposal),
  });
  const rebound = await f.service.bind(
    'pi_reinstalled',
    f.packageRecord,
    owner('bind-shared', 'confirm-after-reinstall'),
    proposal.proposalRef,
  );
  assert.equal(rebound.binding.state, 'active');
});

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
