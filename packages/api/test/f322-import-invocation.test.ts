import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import {
  type InvocationDeps,
  invokeSingleCat,
} from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../src/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../src/domains/cats/services/stores/ports/ContextEpochStore.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';

for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig('../../cat-template.json')))) {
  if (!catRegistry.has(id)) catRegistry.register(id, config);
}

test('an explicit imported active binding takes precedence over a reborn default', async () => {
  const catId = createCatId('codex');
  const userId = 'u';
  const threads = new ThreadStore();
  const thread = threads.create(userId);
  threads.isRebornSession = () => true;
  const sessions = new SessionChainStore();
  const record = sessions.create({ threadId: thread.id, catId, userId, cliSessionId: 'native-original' });
  sessions.update(record.id, {
    externalImport: {
      cliSessionId: 'native-original',
      clientId: 'openai',
      projectPath: '/project',
      firstPrompt: 'original',
      lastActivityAt: 1,
      importedAt: 2,
    },
  });
  let options: AgentServiceOptions | undefined;
  const deps = {
    registry: {
      create: () => ({ invocationId: 'f322-import-reborn', callbackToken: 'test-token' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp',
    },
    threadStore: threads,
    sessionChainStore: sessions,
    apiUrl: 'http://127.0.0.1:3172',
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
  } as unknown as InvocationDeps;
  const service = {
    async *invoke(_prompt: string, input?: AgentServiceOptions) {
      options = input;
      yield { type: 'done' as const, catId, timestamp: Date.now() };
    },
  };
  for await (const _message of invokeSingleCat(deps, {
    catId,
    userId,
    threadId: thread.id,
    prompt: 'Continue the original task',
    service,
    capacitySnapshot: {
      capacity: { windowTokens: 0, inputCeilingTokens: 0, source: 'unresolved', provenance: 'test', actionable: false },
      capability: {
        provider: 'test',
        carrier: 'test_stream',
        reportsRuntimeWindow: false,
        authoritativeUsage: false,
        nativeWindowControl: false,
        nativeCompressionControl: false,
        observesCompression: false,
        reason: 'test',
      },
    },
  })) {
  }
  assert.ok(options, 'the test provider must be reached');
  assert.equal(options.sessionId, 'native-original');
  assert.equal(options.requireExactResume, true);
});
