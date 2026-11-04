import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { InvocationServiceScope } from '../dist/domains/cats/services/agents/invocation/invocation-service-scope.js';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { createRefreshingAcpSessionProvider } from '../dist/domains/cats/services/agents/session-contract/refreshing-acp-session-provider.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';

function member(t) {
  const all = catRegistry.getAllConfigs();
  const catId = 'implementation-freeze';
  catRegistry.register(catId, {
    ...all.codex,
    id: catId,
    configurationSource: 'native_tool',
    accountRef: undefined,
    mcpSupport: false,
  });
  t.after(() => {
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
  });
  return catId;
}

for (const change of ['revision', 'registration']) {
  test(`formal admission detects an implementation ${change} change while capturing configuration`, async (t) => {
    const catId = member(t);
    const registry = new SessionImplementationRegistry();
    const ref = { pluginId: 'fixture-client', contributionId: 'acp' };
    let revision = 1,
      enter,
      release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const concrete = {
      async captureInvocationOptions() {
        enter();
        await gate;
        return {};
      },
      async *invoke() {
        assert.fail('admission must not start a model turn');
      },
    };
    let actual = concrete;
    const provider = createRefreshingAcpSessionProvider({
      catId,
      scope: {},
      revision: () => revision,
      createService: async () => actual,
    });
    const remove = registry.register(ref, () => provider);
    const service = new RegisteredSessionAgentService({ catId, ref, registry });
    await service.prepare();
    const scope = new InvocationServiceScope();
    t.after(() => scope.dispose());
    const pinned = scope.pin(service);
    const previousImplementation = pinned.implementationSnapshot?.();
    const deps = { threadStore: null, apiUrl: 'http://127.0.0.1:13004' };
    const input = { catId, threadId: 'thread', userId: 'owner', service: pinned };
    const pending = prepareInvocationExecutionBinding(deps, input);
    await entered;
    actual = { ...concrete };
    if (change === 'revision') revision++;
    else {
      remove();
      const next = createRefreshingAcpSessionProvider({
        catId,
        scope: {},
        revision: () => revision,
        createService: async () => actual,
      });
      registry.register(ref, () => next);
    }
    await service.prepare();
    release();
    await assert.rejects(pending, (error) => error.statusCode === 409 && /generation_changed/.test(error.message));
    const nextBinding = await prepareInvocationExecutionBinding(deps, { ...input, service: scope.pin(service) });
    assert.equal(nextBinding.implementation.key, 'plugin:fixture-client/acp');
    assert.ok(nextBinding.implementation.generation);
    assert.notEqual(nextBinding.implementation.generation, previousImplementation?.generation);
    assert.ok(Object.isFrozen(nextBinding.implementation));
  });
}

test('native pinned views retain their actual service generation, and replacements get a new one', async (t) => {
  const catId = member(t);
  const scope = new InvocationServiceScope();
  t.after(() => scope.dispose());
  const concrete = {
    forInvocation() {
      return { ...this };
    },
    freshnessCarrierCapability: () => ({ provider: 'openai_codex', carrier: 'codex_exec_json' }),
    async *invoke() {
      assert.fail('capture must not launch a model');
    },
  };
  const deps = { threadStore: null, apiUrl: 'http://127.0.0.1:13004' };
  const input = { catId, threadId: 'thread', userId: 'owner' };
  const before = await prepareInvocationExecutionBinding(deps, { ...input, service: scope.pin(concrete) });
  const same = await prepareInvocationExecutionBinding(deps, { ...input, service: scope.pin(concrete) });
  const after = await prepareInvocationExecutionBinding(deps, { ...input, service: scope.pin({ ...concrete }) });
  assert.ok(before.implementation);
  assert.equal(before.implementation.key, 'builtin:openai/codex_exec_json');
  assert.equal(before.implementation.generation, same.implementation.generation);
  assert.notEqual(before.implementation.generation, after.implementation.generation);
});
