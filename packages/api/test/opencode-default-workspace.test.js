import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const keys = [
  'HOME',
  'USERPROFILE',
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'AUDIT_LOG_DIR',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT',
];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let root, workspace, runtime, invokeSingleCat, ThreadStore, resolveInvocationCapacitySnapshot;
const catId = 'oc-default-workspace-fixture';

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'oc-default-workspace-')));
  workspace = await realpath(await mkdtemp(join(root, 'project-')));
  runtime = await realpath(await mkdtemp(join(root, 'runtime-')));
  Object.assign(process.env, {
    HOME: root,
    USERPROFILE: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    AUDIT_LOG_DIR: root,
    CAT_CAFE_WORKSPACE_ROOT: workspace,
    CAT_CAFE_RUNTIME_ROOT: runtime,
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
  });
  ({ invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'));
  const { _resetOpenCodeKnownModels } = await import(
    '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'
  );
  _resetOpenCodeKnownModels(new Set()); // No real CLI discovery in this invocation fixture.
  ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
  ({ resolveInvocationCapacitySnapshot } = await import(
    '../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'
  ));
  catRegistry.register(catId, {
    id: catId,
    name: 'OpenCode',
    displayName: 'OpenCode',
    clientId: 'opencode',
    provider: 'opencode',
    configurationSource: 'native_tool',
    defaultModel: 'opencode/fixture',
    avatar: '/avatars/opencode.png',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: ['@opencode'],
    mcpSupport: false,
    roleDescription: 'fixture',
    personality: 'fixture',
  });
});
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

async function dispatch(threadStore, threadId = 'default', userId = 'user-1') {
  const optionsSeen = [],
    messages = [];
  const service = {
    l0CompilerFn: async () => '# Test identity',
    contextCapability: () => ({
      provider: 'opencode',
      carrier: 'test',
      reportsRuntimeWindow: false,
      authoritativeUsage: true,
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: false,
      reason: 'controlled provider',
    }),
    async *invoke(_prompt, options) {
      optionsSeen.push(options);
      yield { type: 'text', catId, content: 'controlled reply', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const capacitySnapshot = await resolveInvocationCapacitySnapshot({ catId, threadId, service });
  const deps = {
    registry: {
      create: () => ({ invocationId: 'oc-default-inv', callbackToken: 'fixture' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
    },
    threadStore,
    apiUrl: 'http://127.0.0.1:1',
  };
  for await (const message of invokeSingleCat(deps, {
    catId,
    service,
    capacitySnapshot,
    prompt: 'hi',
    userId,
    threadId,
    isLastCat: true,
  }))
    messages.push(message);
  return { optionsSeen, messages };
}

test('literal default lobby uses the existing persistent default workspace without rebinding', async () => {
  const store = new ThreadStore();
  const before = structuredClone(store.get('default'));
  const result = await dispatch(store);
  assert.equal(
    result.optionsSeen.length,
    1,
    JSON.stringify(result.messages.filter((message) => message.type === 'error')),
  );
  assert.equal(result.optionsSeen[0].workingDirectory, workspace);
  assert.equal(store.get('default').projectPath, before.projectPath);
  assert.ok(result.messages.some((message) => message.type === 'system_info' && message.content?.includes(workspace)));
});

test('real messages route admits the literal default target and dispatch uses its canonical workspace', async () => {
  const { default: Fastify } = await import('fastify');
  const { messagesRoutes } = await import('../dist/routes/messages.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const store = new ThreadStore(),
    queue = new InvocationQueue(),
    app = Fastify();
  await app.register(messagesRoutes, {
    threadStore: store,
    messageStore: new MessageStore(),
    invocationQueue: queue,
    uploadDir: join(root, 'uploads'),
    socketManager: { emitToUser() {} },
    router: {
      previewTargets: async () => ({ targetCats: [], reason: { kind: 'default_cat' } }),
      resolveExplicitTargets: async (ids) => ids,
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { content: '@opencode hi', threadId: 'default', mentions: [catId] },
    });
    assert.equal(response.statusCode, 202, response.body);
    const admitted = queue.peekNextQueued('default', 'user-1');
    assert.equal(admitted.threadId, 'default');
    assert.deepEqual(admitted.targets, [catId]);
    // The consumer is controlled; admission/store/invocation workspace resolution are real.
    const result = await dispatch(store, admitted.threadId, admitted.userId);
    assert.equal(
      result.optionsSeen.length,
      1,
      JSON.stringify(result.messages.filter((message) => message.type === 'error')),
    );
    assert.equal(result.optionsSeen[0].workingDirectory, workspace);
    assert.equal(store.get('default').projectPath, 'default');
  } finally {
    await app.close();
  }
});

test('owned new conversation with no selected project uses the same default workspace', async () => {
  const store = new ThreadStore();
  const thread = store.create('user-1');
  const result = await dispatch(store, thread.id);
  assert.equal(
    result.optionsSeen.length,
    1,
    JSON.stringify(result.messages.filter((message) => message.type === 'error')),
  );
  assert.equal(result.optionsSeen[0].workingDirectory, workspace);
  assert.equal(store.get(thread.id).projectPath, 'default');
});

test('an explicitly selected project remains authoritative', async () => {
  const selected = await realpath(await mkdtemp(join(root, 'selected-')));
  const store = new ThreadStore();
  const thread = store.create('user-1', null, selected);
  const result = await dispatch(store, thread.id);
  assert.equal(
    result.optionsSeen.length,
    1,
    JSON.stringify(result.messages.filter((message) => message.type === 'error')),
  );
  assert.equal(result.optionsSeen[0].workingDirectory, selected);
  assert.equal(store.get(thread.id).projectPath, selected);
});

for (const mode of [
  'missing-runtime-workspace',
  'invalid-default',
  'runtime-is-default',
  'denied-default',
  'foreign-owner',
  'system-thread',
  'deleted-thread',
  'missing-thread',
  'lookup-failed',
  'invalid-selected',
  'virtual-game',
]) {
  test(`default workspace never bypasses ${mode}`, async () => {
    const store = new ThreadStore();
    const thread = store.create(mode === 'foreign-owner' ? 'other-user' : 'user-1');
    if (mode === 'system-thread') thread.systemKind = 'connector_hub';
    if (mode === 'deleted-thread') store.softDelete(thread.id);
    if (mode === 'invalid-selected') store.updateProjectPath(thread.id, join(root, 'missing-selected'));
    if (mode === 'virtual-game') store.updateProjectPath(thread.id, 'games/werewolf');
    const saved = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const savedRoots = process.env.PROJECT_ALLOWED_ROOTS;
    if (mode === 'missing-runtime-workspace') delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    if (mode === 'invalid-default') process.env.CAT_CAFE_WORKSPACE_ROOT = join(root, 'missing-workspace');
    if (mode === 'runtime-is-default') process.env.CAT_CAFE_WORKSPACE_ROOT = runtime;
    if (mode === 'denied-default') process.env.PROJECT_ALLOWED_ROOTS = runtime;
    const target =
      mode === 'lookup-failed'
        ? {
            ...store,
            get: async () => {
              throw new Error('controlled store failure');
            },
          }
        : store;
    try {
      const result = await dispatch(target, mode === 'missing-thread' ? 'does-not-exist' : thread.id);
      assert.equal(result.optionsSeen.length, 0, 'unsafe defaults must not reach the provider');
      assert.ok(result.messages.some((message) => message.type === 'error'));
    } finally {
      process.env.CAT_CAFE_WORKSPACE_ROOT = saved;
      if (savedRoots === undefined) delete process.env.PROJECT_ALLOWED_ROOTS;
      else process.env.PROJECT_ALLOWED_ROOTS = savedRoots;
    }
  });
}
