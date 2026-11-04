import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { agentSessionMutex } from '../../dist/domains/cats/services/agents/invocation/AgentSessionMutex.js';
import { routeParallel } from '../../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';
import { collect, FakeSessionProvider, options } from './fake-session-provider.js';

test('a thrown start keeps acceptance and teardown unknown rather than inventing a rejection', async () => {
  const provider = new FakeSessionProvider();
  provider.beforeVerdictError = new Error('start reply lost');
  const bridge = new AgentSessionBridgeService({
    catId: 'codex',
    provider,
    resolveHostSession: () => ({ sessionId: 'owned-host' }),
  });
  const messages = await collect(bridge.invoke('owned', options()));
  assert.equal(messages.at(-1).providerTeardown, 'unconfirmed');
});

for (const code of ['busy', 'session_unavailable', 'failed'])
  test(`explicit start rejection ${code} does not invent an unconfirmed execution`, async () => {
    const provider = new FakeSessionProvider();
    provider.startResult = { ok: false, code, reason: 'owned not accepted' };
    const bridge = new AgentSessionBridgeService({
      catId: 'codex',
      provider,
      resolveHostSession: () => ({ sessionId: 'owned-host' }),
    });
    const messages = await collect(bridge.invoke('owned', options()));
    assert.equal(messages.at(-1).errorCode, code);
    assert.equal(provider.bytes.length, 0);
    assert.equal(
      messages.at(-1).providerTeardown,
      undefined,
      'a rejected start did not create an execution whose stop is unknown',
    );
  });

for (const route of [routeSerial, routeParallel])
  test(`${route.name} explicit start rejection terminalizes its own child instead of stranding running`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const all = catRegistry.getAllConfigs();
    const catId = 'explicit-start-rejected';
    catRegistry.register(catId, {
      ...all.codex,
      id: catId,
      mcpSupport: false,
      configurationSource: 'native_tool',
      accountRef: undefined,
    });
    t.after(() => {
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
      agentSessionMutex.forceReleaseByScope({ threadId: 'owned-start-rejected', userId: 'owner', catId });
    });
    const provider = new FakeSessionProvider();
    provider.startResult = { ok: false, code: 'failed', reason: 'owned not accepted' };
    const bridge = new AgentSessionBridgeService({
      catId,
      provider,
      resolveHostSession: () => ({ sessionId: 'owned-host' }),
    });
    const { deps } = routingJourneyDeps(undefined, undefined, bridge);
    deps.services = { [catId]: bridge };
    const messages = await collect(
      route(deps, [catId], 'owned task', 'owner', 'owned-start-rejected', { thinkingMode: 'play' }),
    );
    const record = await deps.invocationDeps.turnExecutionStore.get('journey-1');
    assert.equal(provider.bytes.length, 0);
    assert.equal(record.status, 'failed', 'an explicit non-admission is an ordinary terminal failure');
    assert.equal(
      messages.some((message) => message.providerTeardown === 'unconfirmed'),
      false,
    );
  });

test('serial consumer return after source teardown failure does not synthesize a final done for the still-running child', async (t) => {
  t.after(isolateAccountAuthEnvironment());
  const all = catRegistry.getAllConfigs(),
    catId = 'return-unconfirmed';
  catRegistry.register(catId, {
    ...all.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  });
  t.after(() => {
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    agentSessionMutex.forceReleaseByScope({ threadId: 'owned-return-unconfirmed', userId: 'owner', catId });
  });
  const service = {
    cancellationMode: 'drain',
    async *invoke() {
      try {
        yield { type: 'text', catId, content: 'owned running', timestamp: 1 };
      } finally {
        throw new Error('owned return cleanup failure');
      }
    },
  };
  const { deps } = routingJourneyDeps(undefined, undefined, service);
  deps.services = { [catId]: service };
  const iterator = routeSerial(deps, [catId], 'owned task', 'owner', 'owned-return-unconfirmed', {
    thinkingMode: 'play',
  })[Symbol.asyncIterator]();
  t.after(async () => {
    await iterator.return().catch(() => {});
  });
  while (true) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === 'text') break;
  }
  const outcome = await iterator.return().then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  assert.equal((await deps.invocationDeps.turnExecutionStore.get('journey-1')).status, 'running');
  assert.equal(
    outcome.result?.value?.type === 'done',
    false,
    'a safety-net final done cannot override failed teardown on consumer return',
  );
});
