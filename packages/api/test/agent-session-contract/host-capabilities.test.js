import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveInvocationCapacitySnapshot } from '../../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js';
import { assertToolExecutionPolicySupported } from '../../dist/domains/cats/services/agents/invocation/tool-execution-policy.js';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import {
  AcpSessionProvider,
  createRefreshingAcpSessionProvider,
} from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { collect, deferred, options } from './fake-session-provider.js';

const ref = { pluginId: 'local.agent-session-reference', contributionId: 'agent' };
const readOnly = { mode: 'read_only', replayDeniedToolNames: [] };
function native(providerName = 'google', agy = true, extra = {}) {
  return new AcpAgentService({
    catId: 'codex',
    pool: {},
    poolKey: {},
    projectRoot: '/tmp',
    providerName,
    contextBinding: { model: 'actual-model', windowTokens: 64000, source: 'service_spawn' },
    ...(agy ? { antigravity: { profile: {}, profileHome: '/tmp' } } : {}),
    ...extra,
  });
}
function bound(provider) {
  const registry = new SessionImplementationRegistry();
  const remove = registry.register(ref, () => provider);
  const service = new RegisteredSessionAgentService({ catId: 'codex', ref, registry });
  return { registry, remove, service };
}
function sameHostConsumers(service, actual) {
  assert.equal(service.injectsL0Natively?.(), actual.injectsL0Natively());
  assert.deepEqual(service.freshnessCarrierCapability?.(), actual.freshnessCarrierCapability());
  assert.deepEqual(
    resolveInvocationCapacitySnapshot({ catId: 'codex', service }),
    resolveInvocationCapacitySnapshot({ catId: 'codex', service: actual }),
  );
  for (const policy of [readOnly, { mode: 'callback_allowlist', allowedCallbackRoutes: [] }]) {
    if (actual.supportsToolExecutionPolicy(policy))
      assert.doesNotThrow(() => assertToolExecutionPolicySupported(service, policy));
    else
      assert.throws(() => assertToolExecutionPolicySupported(service, policy), {
        code: 'read_only_tool_policy_unavailable',
      });
  }
}

for (const [providerName, agy] of [
  ['google', true],
  ['kimi', false],
  ['other', false],
])
  test(`bound ${providerName} preserves actual L0, retry carrier, policy and invocation capacity before first turn`, async () => {
    const actual = native(providerName, agy);
    const { service } = bound(new AcpSessionProvider({ catId: 'codex', service: actual }));
    await service.prepare?.();
    sameHostConsumers(service, actual);
  });

test('asynchronous construction and member refresh publish only the current actual Host service', async () => {
  let revision = 1;
  let builds = 0;
  let actual = native();
  const provider = createRefreshingAcpSessionProvider({
    catId: 'codex',
    scope: {},
    revision: () => revision,
    createService: async () => {
      builds++;
      return actual;
    },
  });
  const { service } = bound(provider);
  assert.equal(service.injectsL0Natively?.(), undefined);
  await service.prepare?.();
  sameHostConsumers(service, actual);
  assert.equal(builds, 1, 'Host queries prepare the same service used for the turn');
  actual = native('kimi', false);
  revision++;
  assert.throws(() => assertToolExecutionPolicySupported(service, readOnly), {
    code: 'read_only_tool_policy_unavailable',
  });
  assert.equal(service.contextBinding?.(), undefined, 'old account/model binding cannot leak into a new revision');
  await service.prepare?.();
  sameHostConsumers(service, actual);
  assert.equal(builds, 2);
  actual = null;
  revision++;
  await assert.rejects(() => service.prepare(), /unavailable/);
  assert.equal(service.contextCapability?.(), undefined);
});

test('bound Host context reflects real ACP usage telemetry after a bridged turn', async () => {
  const client = {
    isAlive: true,
    agentCapabilities: {},
    promptCapabilities: {},
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    newSession: async () => ({ sessionId: 'native' }),
    async *promptStream() {
      yield {
        sessionId: 'native',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      };
      yield { sessionId: 'native', update: { sessionUpdate: 'usage_update', used: 123, size: 64000 } };
      return 'end_turn';
    },
  };
  const actual = native('kimi', false, {
    pool: { acquire: async () => ({ client, release() {} }), rememberSession() {} },
  });
  const { service } = bound(new AcpSessionProvider({ catId: 'codex', service: actual }));
  await service.prepare?.();
  assert.equal(service.contextCapability?.().usageTelemetry, 'conditional');
  const messages = await collect(service.invoke('hello', options({ hostSessionId: 'host', workingDirectory: '/tmp' })));
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
  );
  assert.equal(actual.contextCapability().usageTelemetry, 'available');
  assert.equal(service.contextCapability?.().usageTelemetry, 'available', 'Host must read the live concrete service');
  await service.releaseAll('test');
});

test('plugin unregister and replacement revoke Host capability grants immediately, before any next turn', async () => {
  const first = native();
  const { service, registry, remove } = bound(new AcpSessionProvider({ catId: 'codex', service: first }));
  await service.prepare?.();
  sameHostConsumers(service, first);
  remove();
  assert.equal(service.injectsL0Natively?.(), undefined);
  assert.throws(() => assertToolExecutionPolicySupported(service, readOnly), {
    code: 'read_only_tool_policy_unavailable',
  });
  const next = native('kimi', false);
  const replacement = new AcpSessionProvider({ catId: 'codex', service: next });
  registry.register(ref, () => replacement);
  await service.prepare?.();
  sameHostConsumers(service, next);
});

test('an unprepared carrier cannot launch with Host admission computed from missing capabilities', async () => {
  const gate = deferred();
  let invokes = 0;
  const provider = createRefreshingAcpSessionProvider({
    catId: 'codex',
    scope: {},
    revision: () => 1,
    createService: async () => {
      await gate.promise;
      return {
        async *invoke() {
          invokes++;
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      };
    },
  });
  const { service } = bound(provider);
  const preparing = service.prepare();
  const rejected = await collect(service.invoke('hello', options({ hostSessionId: 'host' })));
  assert.deepEqual(
    rejected.map((message) => message.errorCode),
    ['session_host_service_unavailable', 'session_host_service_unavailable'],
  );
  assert.equal(invokes, 0);
  gate.resolve();
  await preparing;
  await collect(service.invoke('hello', options({ hostSessionId: 'host' })));
  assert.equal(invokes, 1);
  await service.releaseAll('test');
});

test('the real invocation consumer never replays an uncertain bound AGY failure', async () => {
  const { invokeSingleCat } = await import('../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
  const { SessionChainStore } = await import('../../dist/domains/cats/services/stores/ports/SessionChainStore.js');
  let launches = 0;
  const actual = native();
  actual.invoke = async function* () {
    launches++;
    yield { type: 'error', catId: 'codex', error: 'Premature close', timestamp: Date.now() };
    yield { type: 'done', catId: 'codex', timestamp: Date.now() };
  };
  const { service } = bound(new AcpSessionProvider({ catId: 'codex', service: actual }));
  await service.prepare();
  const messages = await collect(
    invokeSingleCat(
      {
        registry: { create: () => ({ invocationId: 'inv-uncertain', callbackToken: 'fixture' }) },
        sessionManager: {
          get: async () => null,
          getOrCreate: async () => ({}),
          store: async () => {},
          resolveWorkingDirectory: () => '/tmp',
        },
        sessionChainStore: new SessionChainStore(),
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3162',
      },
      { catId: 'codex', service, prompt: 'hello', userId: 'user', threadId: 'uncertain-bound-agy', isLastCat: true },
    ),
  );
  assert.equal(launches, 1, 'the wrapper must preserve AGY no-replay admission in invokeSingleCat');
  assert.ok(messages.some((message) => message.type === 'error' && message.error === 'Premature close'));
  await service.releaseAll('test');
});

for (const change of ['revision', 'replacement'])
  test(`Host admission and launch stay bound when ${change} changes after admission`, async () => {
    let revision = 1;
    let launches = 0;
    let actual = native();
    actual.invoke = async function* () {
      launches++;
      yield { type: 'done' };
    };
    const provider = createRefreshingAcpSessionProvider({
      catId: 'codex',
      scope: {},
      revision: () => revision,
      createService: async () => actual,
    });
    const { service, registry, remove } = bound(provider);
    await service.prepare();
    const admitted = service.forInvocation?.() ?? service;
    assertToolExecutionPolicySupported(admitted, readOnly);
    assert.equal(admitted.injectsL0Natively(), true);
    assert.equal(admitted.freshnessCarrierCapability().carrier, 'agy_acp');
    actual = native('other', false);
    actual.invoke = async function* () {
      launches++;
      yield { type: 'done' };
    };
    if (change === 'revision') revision++;
    else {
      remove();
      const next = createRefreshingAcpSessionProvider({
        catId: 'codex',
        scope: {},
        revision: () => 1,
        createService: async () => actual,
      });
      registry.register(ref, () => next);
    }
    await service.prepare();
    assert.equal(service.supportsToolExecutionPolicy(readOnly), false);
    const messages = await collect(
      admitted.invoke('readonly work', options({ hostSessionId: 'host', toolExecutionPolicy: readOnly })),
    );
    assert.equal(launches, 0, 'no replacement carrier may launch with admission from an earlier generation');
    assert.ok(messages.some((message) => message.type === 'error'));
    await service.releaseAll('test');
  });

test('revision change during bridge open cannot escape the last launch fence', async (t) => {
  let revision = 1;
  let launches = 0;
  let actual = native();
  actual.invoke = async function* () {
    launches++;
    yield { type: 'done' };
  };
  const provider = createRefreshingAcpSessionProvider({
    catId: 'codex',
    scope: {},
    revision: () => revision,
    createService: async () => actual,
  });
  const { service } = bound(provider);
  await service.prepare();
  const admitted = service.forInvocation();
  const transport = provider.bindHostService(provider.hostService());
  const open = transport.openSession.bind(transport);
  t.mock.method(transport, 'openSession', async (input) => {
    const opened = await open(input);
    actual = native('other', false);
    actual.invoke = async function* () {
      launches++;
      yield { type: 'done' };
    };
    revision++;
    await service.prepare();
    return opened;
  });
  assertToolExecutionPolicySupported(admitted, readOnly);
  const messages = await collect(
    admitted.invoke('readonly work', options({ hostSessionId: 'host', toolExecutionPolicy: readOnly })),
  );
  assert.equal(launches, 0);
  assert.ok(messages.some((message) => message.type === 'error'));
  // Direct callers also cannot submit a policy the replacement cannot enforce.
  const rejected = await collect(
    service.invoke('readonly work', options({ hostSessionId: 'next', toolExecutionPolicy: readOnly })),
  );
  assert.equal(launches, 0);
  assert.ok(rejected.some((message) => message.errorCode === 'read_only_tool_policy_unavailable'));
  await service.releaseAll('test');
});
