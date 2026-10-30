import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { compileL0ViaSubprocess } from '../dist/domains/cats/services/agents/providers/l0-compiler.js';

function fixture(t) {
  const all = catRegistry.getAllConfigs();
  const previous = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = mkdtempSync(join(tmpdir(), 'invocation-frozen-l0-'));
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
  };
  catRegistry.register(catId, member);
  t.after(() => {
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
  });
  return { all, catId, member };
}
const service = { injectsL0Natively: () => true };

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
