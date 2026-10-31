import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { resolveInvocationCapacitySnapshot } from '../src/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js';
import { invokeSingleCat } from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { assembleIncrementalContext } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import { SessionSealer } from '../src/domains/cats/services/session/SessionSealer.js';
import { TranscriptReader } from '../src/domains/cats/services/session/TranscriptReader.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import type { AgentService } from '../src/domains/cats/services/types.js';
import { sessionHooksRoutes } from '../src/routes/session-hooks.js';

const catId = createCatId('codex-sol');
const base = { catId, userId: 'owner', threadId: 'channel' };
function scopedStore() {
  const store = new SessionChainStore();
  const record = store.create({
    ...base,
    scopedInvocation: {
      invocationId: 'public-child',
      executionScope: 'collective-participation',
      originMessageId: 'public-source',
    },
  });
  store.bindCliSessionIdIfUnbound(record.id, 'PUBLIC_NATIVE_CANARY');
  return { store, record };
}

test('an actual ordinary invocation cannot resume a running scoped native ID from an otherwise empty chain', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-home-invoke-'));
  t.after(() => console.info('retained scoped home session fixture:', directory));
  const { store, record } = scopedStore();
  const resumed: Array<string | undefined> = [];
  const service: AgentService = {
    async *invoke(_prompt, options) {
      resumed.push(options?.sessionId);
      yield { type: 'session_init', catId, sessionId: 'ACTUAL_HOME_NATIVE', timestamp: Date.now() };
      yield { type: 'text', catId, content: 'SCRIPTED_HOME_OUTPUT', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const deps = {
    registry: new InvocationRegistry(),
    sessionChainStore: store,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3182',
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => directory,
    },
  };
  const output = [];
  for await (const message of invokeSingleCat(deps as never, {
    ...base,
    service,
    prompt: 'HOME_ONLY',
    ownerAuthProvenance: 'unknown',
    isLastCat: true,
    capacitySnapshot: resolveInvocationCapacitySnapshot({ catId, service }),
  }))
    output.push(message);
  assert.equal(
    output.some((message) => message.type === 'text'),
    true,
    JSON.stringify(output),
  );
  assert.deepEqual(resumed, [undefined]);
  assert.notEqual(store.getActive(catId, base.threadId, base.userId)?.id, record.id);
  assert.equal(store.get(record.id)?.status, 'active');
  assert.equal(store.get(record.id)?.cliSessionId, 'PUBLIC_NATIVE_CANARY');
});

test('ordinary incremental prompts cannot recover scoped file evidence from the full-chain fallback', async () => {
  const { store, record } = scopedStore();
  const messages = new MessageStore();
  messages.append({
    userId: base.userId,
    threadId: base.threadId,
    from: { kind: 'user', userId: base.userId },
    content: 'HOME_ONLY',
    mentions: [],
    timestamp: Date.now(),
  });
  const reads: string[] = [];
  const deps = {
    services: {},
    messageStore: messages,
    invocationDeps: {
      sessionChainStore: store,
      transcriptWriter: {
        getFilesTouched(id: string) {
          reads.push(id);
          return [{ path: 'PUBLIC_FILE_CANARY.md', ops: ['write'] }];
        },
      },
    },
    deliveryCursorStore: { getCursor: async () => null, ackCursor: async () => {} },
  };
  const result = await assembleIncrementalContext(deps as never, base.userId, base.threadId, catId);
  assert.deepEqual(reads, []);
  assert.doesNotMatch(result.contextText, /PUBLIC_FILE_CANARY/);
  assert.equal(store.get(record.id)?.status, 'active');
});

test('home callbacks cannot seal or bookmark a scoped native identity', async (t) => {
  const { store, record } = scopedStore();
  const registry = new InvocationRegistry();
  const auth = await registry.create(
    base.userId,
    catId,
    base.threadId,
    undefined,
    undefined,
    { mode: 'read_only', replayDeniedToolNames: [] },
    undefined,
    'strict',
  );
  const app = Fastify();
  t.after(() => app.close());
  await app.register(sessionHooksRoutes, {
    sessionChainStore: store,
    sessionSealer: new SessionSealer(store),
    transcriptReader: new TranscriptReader({ dataDir: tmpdir() }),
    callbackRegistry: registry,
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  for (const [url, payload] of [
    ['/api/sessions/seal', { cliSessionId: 'PUBLIC_NATIVE_CANARY', reason: 'manual' }],
    ['/api/sessions/sop-bookmark', { cliSessionId: 'PUBLIC_NATIVE_CANARY', skill: 'fixture', sopStage: 'home' }],
  ] as const) {
    const response = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(response.statusCode, 403, response.body);
  }
  assert.equal(store.get(record.id)?.status, 'active');
});
