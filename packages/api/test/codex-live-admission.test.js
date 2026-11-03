import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';

for (const followup of [false, true]) {
  test(`serial Live admission skips ordinary MCP only for the Live member; followup=${followup}`, async (t) => {
    const parent = resolve('artifacts/role-agent-refactor/codex-live-admission');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    mkdirSync(join(root, '.cat-cafe'));
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(root, 'cat-template.json'));
    const previous = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    const all = catRegistry.getAllConfigs();
    const nextId = 'codex-live-followup';
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) =>
      catRegistry.register(id, {
        ...config,
        ...(id === 'codex' ? { mcpSupport: false } : {}),
      }),
    );
    catRegistry.register(nextId, { ...all.codex, id: nextId, mcpSupport: true });
    t.after(() => {
      if (previous === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previous;
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const live = {
      finished: Promise.resolve(),
      ready: async () => {},
      observe: async () => {},
      configure: async () => ({ mcp_servers: {} }),
    };
    const native = new CodexAgentService({ catId: 'codex', model: 'fixture-model' });
    const invoked = [];
    const service = {
      captureInvocationOptions: native.captureInvocationOptions.bind(native),
      async *invoke(_prompt, options) {
        invoked.push(options.liveCompanion);
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const threadStore = new ThreadStore();
    const thread = threadStore.create('owner', 'isolated Live admission');
    const deps = {
      services: { codex: service, [nextId]: service },
      invocationDeps: {
        threadStore,
        apiUrl: 'http://127.0.0.1:13004',
        contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
        registry: {
          create: () => ({ invocationId: 'fixture-live', callbackToken: 'fixture-only' }),
          verify: async () => ({ ok: false }),
        },
        sessionManager: {
          get: async () => null,
          getOrCreate: async () => ({}),
          store: async () => {},
          delete: async () => {},
          resolveWorkingDirectory: () => undefined,
        },
      },
      messageStore: {
        append: async (message) => ({ id: 'fixture-message', ...message }),
        getRecent: () => [],
        getMentionsFor: () => [],
        getRecentMentionsFor: () => [],
        getBefore: () => [],
        getByThread: () => [],
        getByThreadAfter: () => [],
        getByThreadBefore: () => [],
      },
      socketManager: { broadcastToRoom() {} },
    };
    const messages = await Array.fromAsync(
      routeSerial(deps, followup ? ['codex', nextId] : ['codex'], 'isolated Live task', 'owner', thread.id, {
        thinkingMode: 'play',
        liveCompanion: live,
      }),
    );
    const errors = messages.filter((message) => message.type === 'error');
    if (followup) {
      assert.equal(errors.length, 1, 'the ordinary member must still validate its MCP source');
      assert.equal(errors[0].catId, nextId);
      assert.equal(errors[0].errorCode, 'execution_binding_unavailable');
      assert.match(errors[0].error, /capabilities source is missing or unreadable/);
    } else assert.deepEqual(errors, []);
    assert.deepEqual(invoked, [live], 'only the first member receives the Live channel');
  });
}
