import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
import type { AgentMessage, AgentServiceOptions } from '../src/domains/cats/services/types.js';

for (const [id, config] of Object.entries(
  toAllCatConfigs(loadCatConfig(fileURLToPath(new URL('../../../cat-template.json', import.meta.url)))),
)) {
  if (!catRegistry.has(id)) catRegistry.register(id, config);
}

async function run(
  imported: boolean,
  behavior: 'missing' | 'malformed' | 'different' | 'done',
  system?: 'default' | 'system',
) {
  const catId = createCatId('opus');
  const threads = new ThreadStore();
  const thread = system === 'default' ? threads.get('default') : threads.create('u');
  assert.ok(thread);
  thread.titleSource = 'temporary'; // Includes Redis-hydrated empty lobby/system threads.
  if (system === 'system') threads.updateSystemKind(thread.id, 'memory_ops');
  const sessions = new SessionChainStore();
  const record = sessions.create({ threadId: thread.id, catId, userId: 'u', cliSessionId: 'native-original' });
  if (imported)
    sessions.update(record.id, {
      externalImport: {
        cliSessionId: 'native-original',
        clientId: 'anthropic',
        firstPrompt: 'original',
        projectPath: '/tmp',
        lastActivityAt: 1,
        importedAt: 2,
      },
    });
  const inputs: AgentServiceOptions[] = [];
  const prompts: string[] = [];
  let sealRequests = 0;
  const deps = {
    registry: {
      create: () => ({ invocationId: 'f322-guards', callbackToken: 'test' }),
      verify: async () => ({ ok: false }),
    },
    sessionManager: {
      get: async () => 'native-original',
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp',
    },
    threadStore: threads,
    sessionChainStore: sessions,
    apiUrl: 'http://127.0.0.1:3172',
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
    sessionSealer: {
      reconcileStuck: async () => {},
      requestSeal: async () => {
        sealRequests++;
        return { accepted: false };
      },
    },
  } as unknown as InvocationDeps;
  const output: AgentMessage[] = [];
  const service = {
    async *invoke(prompt: string, options?: AgentServiceOptions) {
      assert.ok(options);
      inputs.push(options);
      prompts.push(prompt);
      if ((behavior === 'missing' || behavior === 'malformed') && inputs.length === 1) {
        yield {
          type: 'error' as const,
          catId,
          error:
            behavior === 'missing'
              ? 'No conversation found with session ID: native-original'
              : 'malformed_toolcall: thinking-only',
          timestamp: Date.now(),
        };
      } else if (behavior !== 'done') {
        yield { type: 'session_init' as const, catId, sessionId: 'new-native', timestamp: Date.now() };
      }
      yield { type: 'done' as const, catId, timestamp: Date.now() };
    },
  };
  for await (const message of invokeSingleCat(deps, {
    catId,
    userId: 'u',
    threadId: thread.id,
    prompt: 'Continue',
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
  }))
    output.push(message);
  return { inputs, prompts, output, sessions, record, sealRequests };
}

test('missing Claude history can self-heal normally but an imported history must not start fresh', async () => {
  const ordinary = await run(false, 'missing');
  assert.equal(ordinary.inputs.length, 2, 'control must reach the fresh-session self-heal branch');
  assert.equal(ordinary.inputs[1]?.sessionId, undefined);
  const imported = await run(true, 'missing');
  assert.equal(imported.inputs.length, 1);
  assert.equal(imported.inputs[0]?.sessionId, 'native-original');
  assert.ok(imported.output.some((m) => m.type === 'error' && m.error?.includes('No conversation found')));
});

test('a different provider init cannot overwrite imported native history', async () => {
  const result = await run(true, 'different');
  assert.equal(result.sessions.get(result.record.id)?.cliSessionId, 'native-original');
  assert.equal(result.sessions.getByCliSessionId('new-native'), null);
  assert.ok(result.output.some((m) => m.type === 'error' && m.error?.includes('refusing to replace')));
});

test('a malformed imported turn is visible and never attempts a fresh-session recovery', async () => {
  const ordinary = await run(false, 'malformed');
  assert.equal(ordinary.inputs.length, 2, 'control must reach the malformed fresh-retry branch');
  const imported = await run(true, 'malformed');
  assert.equal(imported.inputs.length, 1);
  assert.equal(imported.sealRequests, 0, 'import errors must not invoke the seal-and-start-fresh path');
  assert.ok(imported.output.some((m) => m.type === 'error' && m.error?.startsWith('malformed_toolcall:')));
});

for (const system of ['default', 'system'] as const) {
  test(`${system} thread never asks the first cat to name the conversation`, async () => {
    const result = await run(false, 'done', system);
    assert.equal(result.inputs.length, 1);
    assert.ok(result.prompts.every((p) => !p.includes('这条对话尚未起名')));
  });
}
