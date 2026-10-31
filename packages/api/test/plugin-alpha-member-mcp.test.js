import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCapabilitiesConfig, resolveServersForCat } from '../dist/config/capabilities/capability-orchestrator.js';
import { bindInvocationPluginMcpView } from '../dist/config/capabilities/invocation-plugin-mcp-view.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { resolveProviderMcpConfigResolution } from '../dist/domains/cats/services/agents/providers/provider-mcp-config.js';
import { fixture } from './helpers/alpha-plugin-runtime-fixture.js';
import { directMcpContract } from './helpers/direct-mcp-contract.js';

test('ordinary Alpha member invocation discovers its local active plugin without publishing shared capabilities', async (t) => {
  const f = await fixture(t, 'alpha');
  await f.mutate(true);
  const before = await readCapabilitiesConfig(f.capabilityProjectRoot);
  const outside = resolveServersForCat(before, 'codex').find((s) => s.capabilityId === `plugin:${f.pluginId}:native`);
  assert.deepEqual(outside.args, ['/formal-runtime/mcp.js']);
  let observed;
  const service = {
    async *invoke() {
      await Promise.resolve();
      const config = await readCapabilitiesConfig(f.capabilityProjectRoot);
      observed = resolveServersForCat(config, 'codex').find((s) => s.capabilityId === `plugin:${f.pluginId}:native`);
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'alpha-member-fixture', callbackToken: 'test-only' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => f.projectRoot,
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    resolveInvocationPluginMcpView: () => f.runtime.supervisor.resolveMemberMcpView(),
  };
  for await (const _ of invokeSingleCat(deps, {
    catId: 'codex',
    service,
    prompt: 'Read the current local plugin context.',
    userId: 'fixture-user',
    threadId: 'ordinary-member-in-alpha',
    isLastCat: true,
    workingDirectory: f.projectRoot,
  })) {
    /* Consume the normal member provider iterator without starting a model. */
  }
  assert.ok(observed, 'the normal member provider was reached');
  assert.ok(
    observed.args[0].startsWith(f.projectRoot),
    'member discovery must select the local activation, not the shared formal-runtime descriptor',
  );
  assert.equal(observed.workingDir.startsWith(f.projectRoot), true);
  assert.equal(observed.enabled, true);
  const local = await f.runtime.supervisor.resolveNativeMcpLaunch({
    mode: 'plugin_native',
    pluginInstanceId: f.installed.pluginInstanceId,
    contributionId: 'native',
  });
  assert.equal(observed.env.CLOWDER_PLUGIN_ACTION_TOKEN, local.env.CLOWDER_PLUGIN_ACTION_TOKEN);
  assert.deepEqual(resolveServersForCat(before, 'codex').find((s) => s.name === outside.name).args, [
    '/formal-runtime/mcp.js',
  ]);
  await f.unchanged();
});

test('provider config uses the isolated activation and original turn context without changing canonical publication', async (t) => {
  const f = await fixture(t, 'alpha');
  await f.mutate(true);
  const saved = process.env.CAT_CAFE_CONFIG_ROOT;
  process.env.CAT_CAFE_CONFIG_ROOT = f.capabilityProjectRoot;
  t.after(() => {
    if (saved === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = saved;
  });
  const view = await f.runtime.supervisor.resolveMemberMcpView();
  const turn = {
    CAT_CAFE_CAT_ID: 'codex',
    CAT_CAFE_API_URL: 'http://127.0.0.1:5712',
    CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'fixture-callback',
  };
  const iterator = bindInvocationPluginMcpView(
    () =>
      (async function* () {
        yield await resolveProviderMcpConfigResolution({
          callbackEnv: turn,
          workingDirectory: f.projectRoot,
          mcpServerPath: new URL('../../mcp-server/dist/index.js', import.meta.url).pathname,
        });
      })(),
    view,
  );
  const resolved = (await iterator.next()).value;
  const { upstream: server } = directMcpContract(resolved.servers[`plugin__${f.pluginId}__native`]);
  assert.ok(server.args[0].startsWith(f.projectRoot));
  assert.equal(server.cwd.startsWith(f.projectRoot), true);
  assert.equal(server.env.CAT_CAFE_API_URL, turn.CAT_CAFE_API_URL);
  assert.equal(server.env.CAT_CAFE_INVOCATION_ID, turn.CAT_CAFE_INVOCATION_ID);
  assert.equal(server.env.CAT_CAFE_CALLBACK_TOKEN, turn.CAT_CAFE_CALLBACK_TOKEN);
  await f.unchanged();
});

test('refresh, disable, re-enable and uninstall retire the previous member launch view', async (t) => {
  const f = await fixture(t, 'alpha');
  await f.mutate(true);
  const configuration = await readCapabilitiesConfig(f.capabilityProjectRoot);
  const selected = async (view) =>
    (
      await bindInvocationPluginMcpView(
        () =>
          (async function* () {
            yield resolveServersForCat(configuration, 'codex').find(
              (s) => s.capabilityId === `plugin:${f.pluginId}:native`,
            );
          })(),
        view,
      ).next()
    ).value;
  const original = await f.runtime.supervisor.resolveMemberMcpView();
  const first = await selected(original);
  assert.equal(first.enabled, true);
  await f.runtime.supervisor.configRefresh(f.installed.pluginInstanceId);
  assert.equal((await selected(original)).enabled, false);
  const refreshed = await f.runtime.supervisor.resolveMemberMcpView();
  assert.equal((await selected(refreshed)).enabled, true);
  await f.mutate(false);
  assert.equal((await selected(refreshed)).enabled, false);
  assert.equal(f.runtime.supervisor.nativeActions.target(first.env.CLOWDER_PLUGIN_ACTION_TOKEN), undefined);
  assert.equal((await f.runtime.supervisor.resolveMemberMcpView()).entries.length, 0);
  await f.mutate(true);
  const renewed = await f.runtime.supervisor.resolveMemberMcpView();
  assert.equal((await selected(renewed)).enabled, true);
  assert.equal((await selected(original)).enabled, false);
  const current = (await f.composition.manager.get(f.pluginId)).plugin;
  await f.composition.manager.uninstall(f.pluginId, { expectedRevision: current.lifecycleRevision });
  assert.equal((await selected(renewed)).enabled, false);
  await f.unchanged();
});
