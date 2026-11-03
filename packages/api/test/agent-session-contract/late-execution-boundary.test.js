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

[
  { dimension: 'generation', compatibilityRevision: undefined },
  { dimension: 'generation', compatibilityRevision: 'same-package-v1' },
  { dimension: 'key', compatibilityRevision: 'same-package-v1' },
  { dimension: 'generation', compatibilityRevision: 'same-package-v1', timing: 'last-await' },
].forEach(({ dimension, compatibilityRevision, timing }) => {
  test(`a Host implementation ${dimension} change after capture is rejected (${compatibilityRevision ?? 'legacy'}, ${timing ?? 'before-invoke'})`, async (t) => {
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
    let key = 'test:late-boundary';
    let calls = 0;
    const service = {
      implementationSnapshot: () => ({ key, generation, compatibilityRevision }),
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
    if (timing === 'last-await')
      deps.invocationDeps.resolveInvocationPluginMcpView = async () => {
        generation = 'generation-2';
      };
    else if (dimension === 'generation') generation = 'generation-2';
    else key = 'test:replacement';
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
});
