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

// Contract: a change in the Host execution environment (client, workspace, implementation,
// account) or an unknown legacy environment never seals, replaces or locks the cat's session.
// The provider decides whether the native ID can be resumed; an unresumable ID is handled by the
// existing resume self-heal (missing_session → one fresh retry), not by a pre-emptive seal.

const STALE_BOUNDARY = Object.freeze({
  v: 1,
  clientId: 'stale-client',
  carrier: 'stale-carrier',
  implementationKey: 'stale-implementation',
  implementationGeneration: 'stale-generation',
  accountRef: 'stale-account',
  accountStateRoot: '/stale/account-state',
  workspaceRoot: '/stale/workspace',
  projectRoot: '/stale/project',
});

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
    implementationSnapshot: () => ({ key: 'test:boundary', generation, compatibilityRevision: generation }),
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
  const legacySession = (cliSessionId, externalImport) => {
    const record = store.create({ catId, threadId: 'thread', userId: 'owner', cliSessionId });
    if (externalImport) store.update(record.id, { externalImport: { cliSessionId, clientId: 'codex' } });
    resume = cliSessionId;
    return record;
  };
  // A history whose persisted boundary differs from today's Host in every dimension.
  const recordedSession = (cliSessionId, externalImport) => {
    const record = store.create({ catId, threadId: 'thread', userId: 'owner' });
    assert.ok(store.bindHostExecutionBoundary(record.id, undefined, STALE_BOUNDARY), 'seed a recorded boundary');
    assert.ok(store.bindCliSessionId(record.id, cliSessionId));
    if (externalImport) store.update(record.id, { externalImport: { cliSessionId, clientId: 'codex' } });
    resume = cliSessionId;
    return record;
  };
  // Invocation must never persist or certify a Host boundary.
  const watchBoundaryWrites = () => {
    const writes = [];
    store.bindHostExecutionBoundary = (...args) => {
      writes.push(args);
      return null;
    };
    return writes;
  };
  return {
    catId,
    store,
    calls,
    deps,
    invoke,
    reload,
    legacySession,
    recordedSession,
    watchBoundaryWrites,
    changeWorkspace: () => {
      projectPath = resolve(process.cwd(), 'test');
    },
    changeImplementation: () => {
      generation = 'controlled-generation-2';
    },
  };
}

function assertKeptSession(f, original, messages, nativeId) {
  assert.equal(f.calls.at(-1).resume, nativeId, 'the original native session must be resumed');
  assert.doesNotMatch(f.calls.at(-1).prompt, /AUTHORIZED_CONTEXT_SUMMARY/, 'no replacement segment context');
  const chain = f.store.getChain(f.catId, 'thread', 'owner');
  assert.equal(chain.length, 1, 'no new segment is created');
  assert.equal(f.store.getActive(f.catId, 'thread', 'owner').id, original.id);
  assert.equal(f.store.get(original.id).status, 'active');
  assert.equal(f.store.get(original.id).cliSessionId, nativeId);
  assert.ok(!messages.some((message) => message.type === 'error'), 'the task is not refused');
  assert.ok(
    !messages.some((message) => message.type === 'system_info' && /session_seal_requested/.test(message.content)),
    'no seal is announced',
  );
}

test('a stable Host environment resumes the same logical and native session', async (t) => {
  const f = fixture(t);
  await f.invoke();
  const original = structuredClone(f.store.getActive(f.catId, 'thread', 'owner'));
  const messages = await f.invoke();
  assert.equal(f.calls.length, 2);
  assertKeptSession(f, original, messages, 'native-1');
});

for (const change of ['client', 'workspace', 'implementation']) {
  test(`a changed ${change} keeps the session instead of sealing it`, async (t) => {
    const f = fixture(t);
    await f.invoke();
    const original = structuredClone(f.store.getActive(f.catId, 'thread', 'owner'));
    if (change === 'client') f.reload({ clientId: 'google' });
    if (change === 'workspace') f.changeWorkspace();
    if (change === 'implementation') f.changeImplementation();
    const messages = await f.invoke();
    assert.equal(f.calls.length, 2);
    assertKeptSession(f, original, messages, 'native-1');
  });
}

test('an avatar edit preserves the native segment', async (t) => {
  const f = fixture(t);
  await f.invoke();
  f.reload({ avatar: 'display-only.png' });
  await f.invoke();
  assert.equal(f.calls[1].resume, 'native-1');
  assert.equal(f.store.getChain(f.catId, 'thread', 'owner').length, 1);
});

test('a legacy session without a recorded environment is resumed, not sealed', async (t) => {
  const f = fixture(t);
  const legacy = f.legacySession('legacy-native');
  const messages = await f.invoke();
  assert.equal(f.calls.length, 1);
  assertKeptSession(f, legacy, messages, 'legacy-native');
});

test('a legacy imported session without a recorded environment is resumed, not locked', async (t) => {
  const f = fixture(t);
  const imported = f.legacySession('imported-native', true);
  const messages = await f.invoke();
  assert.equal(f.calls.length, 1);
  assertKeptSession(f, imported, messages, 'imported-native');
  assert.ok(f.store.get(imported.id).externalImport, 'the import record is retained');
});

test('an imported session keeps running after its workspace changes', async (t) => {
  const f = fixture(t);
  const imported = f.legacySession('imported-native', true);
  await f.invoke();
  f.changeWorkspace();
  const messages = await f.invoke();
  assert.equal(f.calls.length, 2);
  assertKeptSession(f, imported, messages, 'imported-native');
});

test('a session without context reconstruction still runs after an environment change', async (t) => {
  const f = fixture(t);
  await f.invoke();
  const original = structuredClone(f.store.getActive(f.catId, 'thread', 'owner'));
  f.changeWorkspace();
  const messages = await f.invoke({ rebuildPromptAfterSessionSeal: undefined });
  assert.equal(f.calls.length, 2);
  assertKeptSession(f, original, messages, 'native-1');
});

test('a session with a different recorded environment (incl. account) is resumed, not sealed', async (t) => {
  const f = fixture(t);
  const recorded = f.recordedSession('recorded-native');
  const writes = f.watchBoundaryWrites();
  const messages = await f.invoke();
  assert.equal(f.calls.length, 1);
  assertKeptSession(f, recorded, messages, 'recorded-native');
  assert.deepEqual(f.store.get(recorded.id).hostExecutionBoundary, STALE_BOUNDARY, 'the record is not rewritten');
  assert.equal(writes.length, 0, 'invocation never persists a boundary');
});

test('an imported session with a different recorded environment is resumed, not locked', async (t) => {
  const f = fixture(t);
  const imported = f.recordedSession('imported-native', true);
  const writes = f.watchBoundaryWrites();
  const messages = await f.invoke();
  assert.equal(f.calls.length, 1);
  assertKeptSession(f, imported, messages, 'imported-native');
  assert.equal(writes.length, 0, 'invocation never persists a boundary');
});

test('fresh and resumed turns never persist a boundary', async (t) => {
  const f = fixture(t);
  const writes = f.watchBoundaryWrites();
  await f.invoke();
  f.changeWorkspace();
  await f.invoke();
  assert.equal(f.calls.length, 2);
  assert.equal(writes.length, 0);
  assert.equal(f.store.getActive(f.catId, 'thread', 'owner').hostExecutionBoundary, undefined);
});

test('a session rebound during prompt preparation is not sent to the stale native ID', async (t) => {
  const f = fixture(t);
  await f.invoke();
  const original = f.store.getActive(f.catId, 'thread', 'owner');
  // Match Redis semantics: reads return detached snapshots, not live records.
  const get = f.store.get.bind(f.store);
  const getActive = f.store.getActive.bind(f.store);
  f.store.get = (...args) => structuredClone(get(...args));
  f.store.getActive = (...args) => structuredClone(getActive(...args));
  f.deps.routingContextPromptProjection = {
    resolve: async () => {
      assert.ok(f.store.bindCliSessionId(original.id, 'native-rebound'), 'concurrent owner rebind');
      return '';
    },
  };
  const messages = await f.invoke();
  assert.equal(f.calls.length, 1, 'the provider is not invoked with the stale native ID');
  assert.ok(
    messages.some(
      (message) => message.type === 'error' && /session_identity_changed_before_provider_entry/.test(message.error),
    ),
  );
  const after = get(original.id);
  assert.equal(after.status, 'active', 'the newly bound session is not sealed');
  assert.equal(after.cliSessionId, 'native-rebound');
});
