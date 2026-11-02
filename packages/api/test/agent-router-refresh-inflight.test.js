import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

for (const nextState of ['replacement', 'unavailable']) {
  test(`an active serial route keeps its admitted member and sees the next member's ${nextState}`, async (t) => {
    const all = catRegistry.getAllConfigs();
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) =>
      catRegistry.register(id, {
        ...config,
        ...(['codex', 'kimi'].includes(id)
          ? {
              mcpSupport: false,
              configurationSource: 'native_tool',
              accountRef: undefined,
            }
          : {}),
      }),
    );
    t.after(() => {
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    let enter,
      release,
      started = false;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const calls = [];
    const service = (catId, label, paused = false) => ({
      async *invoke() {
        calls.push(label);
        yield { type: 'text', catId, content: label, timestamp: Date.now() };
        if (paused) {
          started = true;
          enter();
          await gate;
          yield { type: 'text', catId, content: `${label}-after-refresh`, timestamp: Date.now() };
        }
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    });
    const agents = new AgentRegistry();
    const first = service('codex', 'first-old', true);
    agents.register('codex', first);
    agents.register('kimi', service('kimi', 'second-old'));
    const { deps: fixture } = routingJourneyDeps(undefined, undefined, first);
    const router = new AgentRouter({
      ...fixture.invocationDeps,
      agentRegistry: agents,
      messageStore: fixture.messageStore,
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      socketManager: { broadcastToRoom() {} },
    });
    const retainedDeps = router.getStrategyDeps();
    const collecting = Array.fromAsync(
      routeSerial(retainedDeps, ['codex', 'kimi'], 'isolated serial work', 'owner', 'refresh-journey', {
        thinkingMode: 'play',
      }),
    );
    await Promise.race([entered, collecting.then(() => assert.ok(started, 'the first member must start'))]);
    await agents.refresh(async () => {
      agents.register('codex', service('codex', 'first-new'));
      if (nextState === 'replacement') agents.register('kimi', service('kimi', 'second-new'));
      else agents.markUnavailable('kimi', { code: 'rejected-account-binding', message: 'owned new diagnostic' });
    });
    router.refreshFromRegistry(agents);
    release();
    const messages = await collecting;
    assert.deepEqual(calls, nextState === 'replacement' ? ['first-old', 'second-new'] : ['first-old']);
    assert.ok(messages.some((message) => message.type === 'text' && message.content === 'first-old-after-refresh'));
    if (nextState === 'replacement')
      assert.deepEqual(
        messages.filter((message) => message.type === 'error'),
        [],
      );
    else
      assert.ok(
        messages.some(
          (message) =>
            message.type === 'error' && message.catId === 'kimi' && message.error.includes('owned new diagnostic'),
        ),
        'the new unavailable cause must reach the actual route',
      );
    await agents.reset();
  });
}
