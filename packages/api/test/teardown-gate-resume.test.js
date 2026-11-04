import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { TurnExecutionStartupReconciler } from '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

test('the original cat and thread resume ordinary tool-enabled work after abandoned Host recovery', async (t) => {
  t.after(isolateAccountAuthEnvironment());
  const originals = catRegistry.getAllConfigs();
  const catId = 'restart-resume';
  catRegistry.register(catId, {
    ...originals.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  });
  t.after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(originals)) catRegistry.register(id, config);
  });
  const calls = [];
  const service = {
    async *invoke(prompt, options) {
      calls.push({ prompt, options });
      yield { type: 'text', catId, content: '原线程继续工作', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const { deps: routing } = routingJourneyDeps(undefined, undefined, service);
  const deps = routing.invocationDeps;
  await deps.turnExecutionStore.createRunning({
    invocationId: 'abandoned-before-restart',
    parentInvocationId: 'old-parent',
    threadId: 'original-thread',
    userId: 'owner',
    catId,
    executionKind: 'ordinary',
    startedAt: 100,
    providerLifecycleTracked: true,
  });
  await deps.turnExecutionStore.markProviderStarted('abandoned-before-restart', 120);
  await new TurnExecutionStartupReconciler({ store: deps.turnExecutionStore, now: () => 300 }).reconcile({
    processStartedAt: 200,
  });
  const messages = await Array.fromAsync(
    invokeSingleCat(deps, {
      userId: 'owner',
      threadId: 'original-thread',
      catId,
      service,
      prompt: '继续原来的工作',
      systemPrompt: 'ROLE',
      isLastCat: true,
      ownerAuthProvenance: 'strict',
    }),
  );
  assert.equal(calls.length, 1, JSON.stringify(messages.filter((message) => message.type === 'error')));
  assert.equal(calls[0].options.toolExecutionPolicy, undefined, 'ordinary work must retain its tools');
  assert.ok(messages.some((message) => message.type === 'text' && message.content.includes('原线程继续工作')));
  assert.equal((await deps.turnExecutionStore.get('abandoned-before-restart')).providerTeardownAt, undefined);
});
