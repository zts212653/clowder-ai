import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { compileL0ViaSubprocess } from '../dist/domains/cats/services/agents/providers/l0-compiler.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';

function fixture(t, overrides = {}) {
  const all = catRegistry.getAllConfigs();
  const previous = process.env.CAT_CAFE_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'invocation-frozen-l0-'));
  process.env.CAT_CAFE_DATA_DIR = dataDir;
  const catId = createCatId('frozen-l0-member');
  const member = {
    ...all.codex,
    id: catId,
    clientId: 'acp',
    accountRef: undefined,
    relationshipKey: 'frozen-member',
    defaultModel: 'fixture-model',
    roleDescription: 'captured role',
    identitySources: undefined,
    ...overrides,
  };
  catRegistry.register(catId, member);
  t.after(() => {
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { all, catId, member };
}
const service = { injectsL0Natively: () => true };

test('scoped SDK admission retains runtime without reading ambient MCP or owner profile', async (t) => {
  const { catId } = fixture(t);
  const runtime = { path: '/fixture/claude', version: '1.2.3', sha256: 'a'.repeat(64) };
  const binding = await prepareInvocationExecutionBinding(
    {
      apiUrl: 'http://127.0.0.1:13004',
      threadStore: null,
      resolveInvocationPluginMcpView: () => {
        throw new Error('ambient MCP read');
      },
      profileRepository: {
        profileDir: () => {
          throw new Error('owner profile read');
        },
      },
    },
    {
      catId,
      userId: 'isolated-owner',
      threadId: 'scoped-thread',
      service: {
        ...service,
        freshnessCarrierCapability: () => ({ carrier: 'claude_agent_sdk' }),
        captureInvocationOptions: async () => ({ claudeSdkRuntime: runtime }),
      },
      toolExecutionPolicy: {
        mode: 'plugin_native',
        pluginInstanceId: 'fixture',
        contributionId: 'tools',
        memberSession: { sessionId: 'member', generation: 1, executionId: 'turn' },
      },
    },
  );
  assert.equal(binding.frozenL0Input.projection, 'scoped-member');
  assert.equal(binding.sharedMcpLaunch.context, undefined);
  assert.equal(binding.sharedMcpLaunch.transport, 'stdio');
  assert.deepEqual(binding.providerOptions, { claudeSdkRuntime: runtime });
});

test('admission fences a role registry change while resolving the thread workspace', async (t) => {
  const { all, catId, member } = fixture(t);
  let enter, release;
  const started = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const binding = prepareInvocationExecutionBinding(
    {
      apiUrl: 'http://127.0.0.1:13004',
      threadStore: {
        get: async () => {
          enter();
          await gate;
          return { id: 'frozen-thread', projectPath: 'default' };
        },
      },
    },
    { catId, userId: 'isolated-owner', threadId: 'frozen-thread', service },
  );
  await started;
  catRegistry.reset();
  Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
  catRegistry.register(catId, { ...member, roleDescription: 'changed during admission' });
  release();
  await assert.rejects(binding, /configuration changed.*admission/i);
});

test('a native invocation carries immutable L0 bytes that survive later role edits', async (t) => {
  const { all, catId, member } = fixture(t);
  const binding = await prepareInvocationExecutionBinding(
    { apiUrl: 'http://127.0.0.1:13004', threadStore: null },
    { catId, userId: 'isolated-owner', threadId: 'frozen-thread', service },
  );
  assert.ok(binding.frozenL0Input);
  catRegistry.reset();
  Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
  catRegistry.register(catId, { ...member, roleDescription: 'later role' });
  const body = await compileL0ViaSubprocess({
    catId,
    userId: 'isolated-owner',
    frozenInput: binding.frozenL0Input,
    requireFrozenInput: true,
  });
  assert.match(body, /角色：captured role/);
  assert.doesNotMatch(body, /later role/);
  assert.equal(Object.isFrozen(binding.frozenL0Input), true);
});

test('admission fences a member change while the concrete provider captures MCP options', async (t) => {
  const { all, catId, member } = fixture(t);
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const pending = prepareInvocationExecutionBinding(
    { apiUrl: 'http://127.0.0.1:13004', threadStore: null },
    {
      catId,
      userId: 'isolated-owner',
      threadId: 'frozen-thread',
      service: {
        ...service,
        captureInvocationOptions: async () => {
          enter();
          await gate;
          return { frozenAcpMcpServers: [] };
        },
      },
    },
  );
  await entered;
  catRegistry.reset();
  Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
  catRegistry.register(catId, { ...member, roleDescription: 'changed during MCP capture' });
  release();
  await assert.rejects(pending, /configuration changed.*admission/i);
});

test('Claude admission rejects a login change during the final thread read', async (t) => {
  const { all, catId, member } = fixture(t);
  const priorToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => {
    if (priorToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorToken;
  });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-before-final-thread-read';
  catRegistry.reset();
  Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
  catRegistry.register(catId, {
    ...member,
    clientId: 'anthropic',
    accountRef: 'claude',
    defaultModel: 'claude-fable-5',
  });
  let threadReads = 0;
  const pending = prepareInvocationExecutionBinding(
    {
      apiUrl: 'http://127.0.0.1:13004',
      threadStore: {
        get: async () => ({ id: 'frozen-thread', projectPath: 'default' }),
        getMemberEffort: async () => {
          if (++threadReads === 2) process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-after-final-thread-read';
        },
      },
    },
    { catId, userId: 'isolated-owner', threadId: 'frozen-thread', service, toolExecutionPolicy: { mode: 'read_only' } },
  );
  await assert.rejects(pending, /Execution configuration changed during execution admission/);
});

test(
  'Claude admission rejects an effort edit during the final Keychain read',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const env = { ...process.env };
    const { catId } = fixture(t, {
      clientId: 'anthropic',
      accountRef: 'claude',
      defaultModel: 'claude-fable-5',
    });
    t.after(() => {
      process.env = env;
    });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
    const userId = 'isolated-owner';
    const store = new ThreadStore();
    const thread = store.create(userId, 'Change effort during admission');
    store.updateMemberEffort(thread.id, catId, 'low');

    let keychainReads = 0;
    const execFile = childProcess.execFile;
    const keychain = t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
      if (file !== '/usr/bin/security') return execFile(file, args, options, callback);
      const read = ++keychainReads;
      setImmediate(() => {
        if (read === 2) store.updateMemberEffort(thread.id, catId, 'high');
        callback(null, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }), '');
      });
      return {};
    });
    syncBuiltinESMExports();
    t.after(() => {
      keychain.mock.restore();
      syncBuiltinESMExports();
    });

    await assert.rejects(
      prepareInvocationExecutionBinding(
        { apiUrl: 'http://127.0.0.1:13004', threadStore: store },
        { catId, userId, threadId: thread.id, service, toolExecutionPolicy: { mode: 'read_only' } },
      ),
      /Thread execution configuration changed during admission/,
    );
    assert.equal(keychainReads, 2);
    assert.equal(store.getMemberEffort(thread.id, catId, userId), 'high');
  },
);
