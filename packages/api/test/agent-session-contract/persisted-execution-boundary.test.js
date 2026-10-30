import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { invokeSingleCat } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { SessionSealer } from '../../dist/domains/cats/services/session/SessionSealer.js';
import { SessionChainStore } from '../../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';

function fixture(t) {
  t.after(isolateAccountAuthEnvironment());
  const originals = catRegistry.getAllConfigs();
  const catId = 'persisted-execution-boundary';
  let config = {
    ...originals.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  };
  const reload = (patch) => {
    config = { ...config, ...patch };
    catRegistry.reset();
    Object.entries(originals).forEach(([id, member]) => {
      catRegistry.register(id, member);
    });
    catRegistry.register(catId, config);
  };
  reload({});
  t.after(() => {
    catRegistry.reset();
    Object.entries(originals).forEach(([id, member]) => {
      catRegistry.register(id, member);
    });
  });
  const store = new SessionChainStore();
  const calls = [];
  let resume;
  let projectPath = resolve(process.cwd());
  let generation = 'controlled-generation-1';
  const service = {
    implementationSnapshot: () => ({ key: 'test:boundary', generation }),
    async *invoke(prompt, options) {
      calls.push({ prompt, resume: options.cliSessionId, hostSessionId: options.hostSessionId });
      yield {
        type: 'session_init',
        catId,
        sessionId: options.cliSessionId ?? `native-${calls.length}`,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const { deps: routing } = routingJourneyDeps(undefined, undefined, service);
  const deps = routing.invocationDeps;
  deps.sessionChainStore = store;
  deps.sessionSealer = new SessionSealer(store);
  deps.threadStore = { get: () => ({ id: 'thread', projectPath }) };
  deps.sessionManager.get = async () => resume;
  deps.sessionManager.store = async (_user, _cat, _thread, id) => {
    resume = id;
  };
  deps.sessionManager.delete = async () => {
    resume = undefined;
  };
  const invoke = (extra = {}) =>
    Array.fromAsync(
      invokeSingleCat(deps, {
        catId,
        service,
        userId: 'owner',
        threadId: 'thread',
        prompt: 'CURRENT_TASK',
        systemPrompt: 'ROLE',
        isLastCat: true,
        ownerAuthProvenance: 'strict',
        rebuildPromptAfterSessionSeal: async () => 'AUTHORIZED_CONTEXT_SUMMARY\nCURRENT_TASK',
        ...extra,
      }),
    );
  return {
    catId,
    store,
    calls,
    deps,
    invoke,
    reload,
    changeWorkspace: () => {
      projectPath = resolve(process.cwd(), 'test');
    },
    changeImplementation: () => {
      generation = 'controlled-generation-2';
    },
  };
}

test('a stable persisted Host binding resumes the same logical and native session', async (t) => {
  const f = fixture(t);
  await f.invoke();
  const original = structuredClone(f.store.getActive(f.catId, 'thread', 'owner'));
  assert.ok(original.hostExecutionBoundary, 'the canonical store must retain selected Host boundary facts');
  await f.invoke();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].resume, 'native-1');
  assert.equal(f.store.getActive(f.catId, 'thread', 'owner').id, original.id);
});

for (const change of ['client', 'workspace', 'implementation']) {
  test(`a changed ${change} cannot submit a task to the old native segment`, async (t) => {
    const f = fixture(t);
    await f.invoke();
    const original = structuredClone(f.store.getActive(f.catId, 'thread', 'owner'));
    if (change === 'client') f.reload({ clientId: 'google' });
    if (change === 'workspace') f.changeWorkspace();
    if (change === 'implementation') f.changeImplementation();
    await f.invoke();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].resume, undefined, 'the prior runtime ID must not cross a hard boundary');
    assert.match(f.calls[1].prompt, /AUTHORIZED_CONTEXT_SUMMARY/);
    const old = f.store.get(original.id);
    const next = f.store.getActive(f.catId, 'thread', 'owner');
    assert.equal(old.status, 'sealed');
    assert.equal(old.cliSessionId, 'native-1', 'old history remains addressable');
    assert.match(old.sealReason, /execution_boundary/);
    assert.notEqual(next.id, original.id);
    assert.equal(next.seq, original.seq + 1);
    assert.equal(next.cliSessionId, 'native-2');
  });
}

test('an avatar edit preserves a compatible native segment', async (t) => {
  const f = fixture(t);
  await f.invoke();
  f.reload({ avatar: 'display-only.png' });
  await f.invoke();
  assert.equal(f.calls[1].resume, 'native-1');
  assert.equal(f.store.getChain(f.catId, 'thread', 'owner').length, 1);
});

test('unknown legacy binding creates a fresh segment without rewriting its native history', async (t) => {
  const f = fixture(t);
  const legacy = f.store.create({ catId: f.catId, threadId: 'thread', userId: 'owner', cliSessionId: 'legacy-native' });
  await f.invoke();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].resume, undefined);
  assert.equal(f.store.get(legacy.id).cliSessionId, 'legacy-native');
  assert.equal(f.store.get(legacy.id).status, 'sealed');
});

test('an explicitly imported history with unknown binding fails without replacing it', async (t) => {
  const f = fixture(t);
  const legacy = f.store.create({
    catId: f.catId,
    threadId: 'thread',
    userId: 'owner',
    cliSessionId: 'imported-native',
  });
  f.store.update(legacy.id, { externalImport: { cliSessionId: 'imported-native', clientId: 'codex' } });
  const messages = await f.invoke();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get(legacy.id).status, 'active');
  assert.ok(messages.some((message) => message.type === 'error'));
});

test('a failed boundary persistence cannot expose the current task to the provider', async (t) => {
  const f = fixture(t);
  f.store.bindHostExecutionBoundary = async () => {
    throw new Error('controlled boundary write failure');
  };
  const messages = await f.invoke();
  assert.equal(f.calls.length, 0);
  assert.ok(messages.some((message) => message.type === 'error'));
});

test('a changed boundary without context reconstruction fails before sealing history', async (t) => {
  const f = fixture(t);
  await f.invoke();
  const prior = f.store.getActive(f.catId, 'thread', 'owner');
  f.changeWorkspace();
  const messages = await f.invoke({ rebuildPromptAfterSessionSeal: undefined });
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get(prior.id).status, 'active');
  assert.ok(
    messages.some(
      (message) => message.type === 'error' && /execution_boundary_rollover_unavailable/.test(message.error),
    ),
  );
});

test('a failed final provider-entry comparison cannot send the task', async (t) => {
  const f = fixture(t);
  const bind = f.store.bindHostExecutionBoundary.bind(f.store);
  let comparisons = 0;
  f.store.bindHostExecutionBoundary = (...args) => (++comparisons === 1 ? bind(...args) : null);
  const messages = await f.invoke();
  assert.equal(comparisons, 2);
  assert.equal(f.calls.length, 0);
  assert.ok(messages.some((message) => message.type === 'error'));
});

test('a persistence owner aborting and rejecting together remains an observed failure', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  f.store.bindHostExecutionBoundary = async () => {
    controller.abort();
    throw new Error('controlled canceled boundary write');
  };
  await f.invoke({ signal: controller.signal });
  await new Promise((done) => setImmediate(done));
  assert.equal(f.calls.length, 0);
});
