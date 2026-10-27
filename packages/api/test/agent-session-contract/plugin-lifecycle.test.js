import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { readSessionContractSettings } from '../../dist/domains/cats/services/agents/session-contract/session-contract-settings.js';
import { declaredAgentSessionProviders } from '../../dist/domains/plugin/declared/declared-agent-session-providers.js';
import { DeclaredRuntimeContributions } from '../../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { FilesystemVerifiedPluginPackageLocator } from '../../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../../dist/domains/plugin/index.js';
import { collect, FakeSessionProvider, Inbox, options, turn } from './fake-session-provider.js';

const ref = { pluginId: 'local.agent-session-reference', contributionId: 'agent' };
const declaration = {
  id: 'agent',
  transport: 'acp',
  acp: {
    command: 'node',
    startupArgs: [fileURLToPath(new URL('../fixtures/agent-session-reference/fake-acp-agent.mjs', import.meta.url))],
  },
};
function registered(registry) {
  return new RegisteredSessionAgentService({ catId: 'codex', ref, registry });
}
function failure(messages, code) {
  assert.deepEqual(
    messages.map((m) => [m.type, m.errorCode]),
    [
      ['error', code],
      ['done', code],
    ],
  );
}
test('Host options are opt-in on the bridge, including nonserializable Host ports', async () => {
  const { AgentSessionBridgeService } = await import(
    '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js'
  );
  for (const passHostOptions of [false, true]) {
    const provider = new FakeSessionProvider();
    const opts = options({ runtimeInteractionPort: { invoke() {} } });
    const bridge = new AgentSessionBridgeService({
      catId: 'codex',
      provider,
      passHostOptions,
      resolveHostSession: () => ({ sessionId: 'host' }),
    });
    await collect(bridge.invoke('x', opts));
    assert.equal(provider.calls.start[0].input.hostOptions, passHostOptions ? opts : undefined);
    assert.equal(Object.hasOwn(provider.calls.start[0].input, 'hostOptions'), passHostOptions);
  }
});
test('Registered service handles missing implementation, Host id, invocation id, and replacement', async () => {
  const registry = new SessionImplementationRegistry();
  const service = registered(registry);
  failure(await collect(service.invoke('x', options())), 'session_implementation_unavailable');
  failure(await collect(service.invokeWithContinuityPreflight({}, options())), 'session_implementation_unavailable');
  const first = new FakeSessionProvider();
  const remove = registry.register(ref, () => first);
  failure(await collect(service.invoke('x', options())), 'host_session_unavailable');
  failure(await collect(service.invoke('x', options({ hostSessionId: '' }))), 'host_session_unavailable');
  assert.equal(first.calls.open.length, 0);
  failure(await collect(service.invoke('x', { hostSessionId: 'host' })), 'invocation_id_missing');
  await collect(service.invoke('x', options({ hostSessionId: 'host', sessionId: 'resume' })));
  assert.equal(first.calls.open[0].input.resume.nativeSessionId, 'resume');
  remove();
  const second = new FakeSessionProvider();
  registry.register(ref, () => second);
  await collect(service.invoke('x', options({ hostSessionId: 'host' })));
  assert.deepEqual(first.calls.release, [{ id: 'host', reason: 'implementation_replaced' }]);
  await service.releaseAll('stop');
  await service.releaseAll('again');
  assert.deepEqual(second.calls.release, [{ id: 'host', reason: 'stop' }]);
});
test('missing implementation releases cached bridge before emitting failure', async () => {
  const registry = new SessionImplementationRegistry();
  const provider = new FakeSessionProvider();
  const remove = registry.register(ref, () => provider);
  const service = registered(registry);
  await collect(service.invoke('x', options({ hostSessionId: 'host' })));
  remove();
  failure(await collect(service.invoke('x', options({ hostSessionId: 'host' }))), 'session_implementation_unavailable');
  assert.deepEqual(provider.calls.release, [{ id: 'host', reason: 'implementation_unavailable' }]);
});
async function lifecycle(t, raw = declaration, mode, createProvider) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'source');
  await cp(new URL('../fixtures/agent-session-reference/plugin/', import.meta.url), packageRoot, { recursive: true });
  if (raw === null) await rm(join(packageRoot, 'agent-provider.json'));
  else await writeFile(join(packageRoot, 'agent-provider.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
  const packagesRoot = join(root, 'packages');
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store);
  const installer = new LocalPluginPackageAdmission({ inventory, packagesRoot });
  await installer.install({ kind: 'local-directory', path: packageRoot });
  const snapshot = await store.snapshot();
  const pkg = snapshot.packages[0];
  const instance = snapshot.instances[0];
  assert.equal(pkg.manifest.runtime, undefined);
  const packages = new FilesystemVerifiedPluginPackageLocator(packagesRoot);
  const registry = new SessionImplementationRegistry();
  const service = registered(registry);
  const created = [];
  const logs = [];
  const { default: pino } = await import('pino');
  const log = pino(
    {},
    {
      write(line) {
        logs.push(JSON.parse(line));
      },
    },
  );
  const host = declaredAgentSessionProviders({
    packages,
    registry,
    log,
    services: new Map([['codex', service]]),
    settings: readSessionContractSettings({
      CAT_CAFE_AGENT_SESSION_CONTRACT: mode,
      CAT_CAFE_AGENT_SESSION_BINDINGS: JSON.stringify({ codex: 'plugin:local.agent-session-reference/agent' }),
    }),
    createProvider:
      createProvider ??
      (() => {
        const provider = new FakeSessionProvider();
        created.push(provider);
        return provider;
      }),
  });
  const runtime = new DeclaredRuntimeContributions({ packages, configuration: {}, agentSessionProviders: host });
  const admission = { instance, packageRecord: pkg };
  return { runtime, admission, registry, service, created, packagesRoot, logs };
}
function assertLifecycleLog(line, result, level, providerId = 'agent') {
  assert.equal(line.pluginId, ref.pluginId);
  assert.equal(line.providerId, providerId);
  assert.equal(line.protocol, 'acp');
  assert.equal(line.result, result);
  assert.equal(line.level, level);
  assert.equal(line.msg, `[session-contract] agent-provider ${result}`);
  return line;
}
test('static reference package passes real local admission; activation/disable/restart use existing lifecycle', async (t) => {
  const h = await lifecycle(t);
  await h.runtime.activate(h.admission, () => assert.fail('plugin code invoked'));
  assert.ok(h.registry.has(ref));
  assert.deepEqual(h.logs, [assertLifecycleLog(h.logs[0], 'registered', 30)]);
  await collect(h.service.invoke('x', options({ hostSessionId: 'host' })));
  const first = h.created[0];
  first.inbox = new Inbox();
  first.inbox.push(turn('status', { phase: 'running' }));
  const iterator = h.service.invoke('running', options({ hostSessionId: 'host' }))[Symbol.asyncIterator]();
  await iterator.next();
  const done = iterator.next();
  await h.runtime.deactivate(h.admission.instance.pluginInstanceId);
  assert.equal((await done).value.errorCode, 'cancelled');
  assert.equal(h.registry.has(ref), false);
  assertLifecycleLog(h.logs[1], 'unregistered', 30);
  assert.equal(first.calls.release.length, 1);
  assert.equal(first.calls.release[0].reason, 'implementation_unregistered');
  await h.runtime.deactivate(h.admission.instance.pluginInstanceId);
  assert.equal(h.logs.length, 2, 'duplicate disable has no duplicate unregister log');
  await h.runtime.activate(h.admission, () => assert.fail('plugin code invoked'));
  await collect(h.service.invoke('new', options({ hostSessionId: 'host' })));
  assert.equal(h.created.length, 2);
  assert.equal(first.calls.release.length, 1);
  await h.runtime.deactivateAll();
});
for (const raw of [
  { ...declaration, entrypoint: 'evil.js' },
  { ...declaration, transport: 'a2a' },
  '{',
  ' '.repeat(65537),
])
  test(`activation rejects invalid/oversized declaration ${typeof raw === 'string' ? raw.length : JSON.stringify(raw)}`, async (t) => {
    const h = await lifecycle(t, raw);
    await assert.rejects(
      h.runtime.activate(h.admission, () => {}),
      /invalid_declaration|transport_not_allowed|JSON|64 KiB/,
    );
    assert.equal(h.registry.has(ref), false);
    assert.equal(h.logs.length, 1);
    assertLifecycleLog(h.logs[0], 'rejected', 40, typeof raw === 'string' ? 'unknown' : 'agent');
    assert.match(h.logs[0].reason, /invalid_declaration|transport_not_allowed|JSON|64 KiB/);
  });
for (const mode of [undefined, 'plugin'])
  test(`enabled mode ${mode ?? 'default'} accepts a package without agent-provider.json`, async (t) => {
    const h = await lifecycle(t, null, mode);
    await h.runtime.activate(h.admission, () => assert.fail('plugin code invoked'));
    assert.equal(h.registry.has(ref), false);
    assert.equal(h.created.length, 0);
    assert.deepEqual(h.logs, []);
    await h.runtime.deactivateAll();
  });

test('off never accesses package declaration or package locator', async () => {
  const host = declaredAgentSessionProviders({
    settings: { mode: 'off' },
    log: { info: () => assert.fail('off logged registration'), warn: () => assert.fail('off logged rejection') },
    packages: {
      resolveInstalledPackage: () => assert.fail('package accessed'),
    },
  });
  assert.equal(await host.activate({}), undefined);
});
test('reference package has no code/runtime; generated script path stays outside package; Host wiring precedes old routing', async () => {
  const dir = new URL('../fixtures/agent-session-reference/plugin/', import.meta.url);
  assert.deepEqual((await readdir(dir)).sort(), ['agent-provider.json', 'manifest.json']);
  assert.equal(JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8')).runtime, undefined);
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.ok(
    source.indexOf('sessionContractSettings.bindings.get(id)') <
      source.indexOf("const acpConfig = config.carrier === 'acp'"),
  );
  assert.ok(source.indexOf('sessionContractSettings.bindings.get(id)') < source.indexOf('switch (config.clientId)'));
  const invocation = await readFile(
    new URL('../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts', import.meta.url),
    'utf8',
  );
  assert.match(invocation, /hostSessionId: activeSessionRecordForResume\?\.id/);
  assert.ok(fileURLToPath(new URL('../fixtures/agent-session-reference/fake-acp-agent.mjs', import.meta.url)));
});

test('disable in first-start scheduling gap never opens an orphan session', async () => {
  const registry = new SessionImplementationRegistry();
  const provider = new FakeSessionProvider();
  const remove = registry.register(ref, () => provider);
  const service = registered(registry);
  const iterator = service.invoke('x', options({ hostSessionId: 'host' }))[Symbol.asyncIterator]();
  const next = iterator.next();
  remove();
  await service.releaseAll('implementation_unregistered');
  assert.equal((await next).value.errorCode, 'cancelled');
  assert.equal((await iterator.next()).done, true);
  assert.equal(provider.calls.open.length, 0);
});

test('disable during open waits for that owned session and releases it once without starting a turn', async () => {
  const { deferred } = await import('./fake-session-provider.js');
  const registry = new SessionImplementationRegistry();
  const provider = new FakeSessionProvider();
  provider.openGate = deferred();
  const remove = registry.register(ref, () => provider);
  const service = registered(registry);
  const run = collect(service.invoke('x', options({ hostSessionId: 'host' })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.calls.open.length, 1);
  remove();
  const stop = service.releaseAll('implementation_unregistered');
  provider.openGate.resolve();
  await stop;
  assert.equal((await run).at(-1).errorCode, 'cancelled');
  assert.equal(provider.calls.release.length, 1);
  assert.equal(provider.calls.start.length, 0);
});

for (const stop of ['caller', 'release'])
  test(`Registered hostOptions only replaces signal; ${stop} cancellation reaches that signal`, async () => {
    const registry = new SessionImplementationRegistry();
    const provider = new FakeSessionProvider();
    provider.inbox = new Inbox();
    provider.inbox.push(turn('status', { phase: 'running' }));
    registry.register(ref, () => provider);
    const service = registered(registry);
    const controller = new AbortController();
    const opts = options({
      hostSessionId: 'host',
      signal: controller.signal,
      callbackEnv: { token: 'test' },
      runtimeInteractionPort: { invoke() {} },
      requiredTools: ['tool'],
    });
    const snapshot = { ...opts };
    const iterator = service.invoke('x', opts)[Symbol.asyncIterator]();
    await iterator.next();
    const received = provider.calls.start[0].input.hostOptions;
    assert.notEqual(received, opts);
    assert.notEqual(received.signal, opts.signal);
    for (const [key, value] of Object.entries(opts)) if (key !== 'signal') assert.equal(received[key], value);
    assert.deepEqual(Object.keys(received).sort(), Object.keys(opts).sort());
    assert.deepEqual(opts, snapshot);
    const next = iterator.next();
    if (stop === 'caller') controller.abort();
    else await service.releaseAll('disabled');
    assert.equal(received.signal.aborted, true);
    assert.equal((await next).value.errorCode, 'cancelled');
    assert.deepEqual(opts, snapshot);
    await service.releaseAll('test');
  });

test('bridge marker uses Pino structured fields and does not log Host credentials', async () => {
  const { default: pino } = await import('pino');
  const lines = [];
  const log = pino(
    {},
    {
      write(line) {
        lines.push(JSON.parse(line));
      },
    },
  );
  const registry = new SessionImplementationRegistry();
  registry.register(ref, () => new FakeSessionProvider());
  const service = new RegisteredSessionAgentService({ catId: 'codex', ref, registry, log });
  await collect(service.invoke('x', options({ hostSessionId: 'host', callbackEnv: { token: 'not-for-logs' } })));
  assert.deepEqual(
    lines.filter((line) => line.msg === '[session-contract] bridged').map((line) => line.catId),
    ['codex'],
  );
  assert.equal(JSON.stringify(lines).includes('not-for-logs'), false);
  await service.releaseAll('test');
});

test('activation waits for the bound concrete Host service; disable revokes its capability surface', async (t) => {
  const { createRefreshingAcpSessionProvider } = await import(
    '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js'
  );
  const { deferred } = await import('./fake-session-provider.js');
  const entered = deferred();
  const gate = deferred();
  const actual = {
    injectsL0Natively: () => true,
    async *invoke() {
      yield { type: 'done' };
    },
  };
  const h = await lifecycle(t, declaration, undefined, () =>
    createRefreshingAcpSessionProvider({
      catId: 'codex',
      scope: {},
      revision: () => 1,
      createService: async () => {
        entered.resolve();
        await gate.promise;
        return actual;
      },
    }),
  );
  let activated = false;
  const activation = h.runtime
    .activate(h.admission, () => assert.fail('plugin code invoked'))
    .then(() => {
      activated = true;
    });
  await entered.promise;
  assert.equal(activated, false);
  assert.equal(h.service.injectsL0Natively?.(), undefined);
  gate.resolve();
  await activation;
  assert.equal(h.service.injectsL0Natively?.(), true);
  await h.runtime.deactivateAll();
  assert.equal(h.service.injectsL0Natively?.(), undefined);
});

test('failed concrete Host preparation rejects activation and unregisters the declaration', async (t) => {
  const { createRefreshingAcpSessionProvider } = await import(
    '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js'
  );
  const h = await lifecycle(t, declaration, undefined, () =>
    createRefreshingAcpSessionProvider({
      catId: 'codex',
      scope: {},
      revision: () => 1,
      createService: async () => {
        throw new Error('actual ACP bootstrap unavailable');
      },
    }),
  );
  await assert.rejects(() => h.runtime.activate(h.admission, () => {}), /actual ACP bootstrap unavailable/);
  assert.equal(h.registry.has(ref), false);
  assert.equal(h.service.contextCapability?.(), undefined);
});
