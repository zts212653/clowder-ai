import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  invokeSingleCat,
  prepareInvocationExecutionBinding,
} from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { SessionSealer } from '../../dist/domains/cats/services/session/SessionSealer.js';
import { SessionChainStore } from '../../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';

test('a Host implementation generation change after binding capture is rejected before provider entry', async (t) => {
  t.after(isolateAccountAuthEnvironment());
  const original = catRegistry.getAllConfigs();
  const catId = 'late-execution-boundary';
  catRegistry.register(catId, {
    ...original.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  });
  t.after(() => {
    catRegistry.reset();
    Object.entries(original).forEach(([id, config]) => catRegistry.register(id, config));
  });
  let generation = 'generation-1';
  let calls = 0;
  const service = {
    implementationSnapshot: () => ({ key: 'test:late-boundary', generation }),
    async *invoke() {
      calls += 1;
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const { deps } = routingJourneyDeps(undefined, undefined, service);
  const store = new SessionChainStore();
  deps.invocationDeps.sessionChainStore = store;
  deps.invocationDeps.sessionSealer = new SessionSealer(store);
  deps.invocationDeps.threadStore = { get: () => ({ id: 'late-thread', projectPath: process.cwd() }) };
  const binding = await prepareInvocationExecutionBinding(deps.invocationDeps, {
    catId,
    threadId: 'late-thread',
    userId: 'late-owner',
    service,
    ownerAuthProvenance: 'strict',
  });
  generation = 'generation-2';
  const messages = await Array.fromAsync(
    invokeSingleCat(deps.invocationDeps, {
      catId,
      service,
      userId: 'late-owner',
      threadId: 'late-thread',
      prompt: 'late boundary',
      systemPrompt: 'review role',
      isLastCat: true,
      ownerAuthProvenance: 'strict',
      executionBinding: binding,
    }),
  );
  assert.equal(calls, 0);
  assert.ok(
    messages.some(
      (message) => message.type === 'error' && /execution_boundary_changed_before_provider_entry/.test(message.error),
    ),
  );
  assert.equal(store.getActive(catId, 'late-thread', 'late-owner').status, 'active');
});
