import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { SessionSealer } from '../src/domains/cats/services/session/SessionSealer.js';
import { TranscriptReader } from '../src/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../src/domains/cats/services/session/TranscriptWriter.js';
import { TranscriptInvocationReader } from '../src/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import type { AgentMessage, AgentService } from '../src/domains/cats/services/types.js';
import { sessionTranscriptRoutes } from '../src/routes/session-transcript.js';

const catId = createCatId('codex-sol');
const source = {
  serviceInstanceId: 'svc_100000000000',
  collectiveId: 'col_100000000000',
  connectionId: 'con_100000000000',
  eventId: 'evt_100000000000',
  catId,
  participationRevision: 1,
  location: { channelId: 'general' },
  actor: { kind: 'human' as const, humanId: 'human_guest00000', displayName: 'Guest' },
};
const event = {
  ...source,
  clientEventId: 'public',
  sequence: 1,
  acceptedAt: new Date().toISOString(),
  body: 'PUBLIC_ONLY',
  recipient: {
    kind: 'agent' as const,
    connectionId: source.connectionId,
    humanId: 'human_owner00000',
    agentId: catId,
    participationRevision: 1,
  },
};
const binding = {
  source,
  sourceRef: 'message:origin',
  displayName: 'Sol',
  grant: { kind: 'collective-participation' as const, originTriggerMessageId: 'origin', source },
  context: { source: event, events: [event] },
};
const forbidden = () => {
  throw new Error('HOME_SESSION_OR_PRIVATE_CONTEXT_WAS_READ');
};

async function harness(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'f290-scoped-public-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const chains = new SessionChainStore();
  const home = chains.create({ userId: 'owner', threadId: 'public', catId, cliSessionId: 'HOME_CANARY' });
  const writer = new TranscriptWriter({ dataDir: directory });
  const executions = new InMemoryTurnExecutionStore();
  const sealer = new SessionSealer(chains, writer);
  const deps = {
    registry: new InvocationRegistry(),
    turnExecutionStore: executions,
    apiUrl: 'http://127.0.0.1:3182',
    sessionChainStore: chains,
    transcriptWriter: writer,
    sessionSealer: sealer,
    sessionManager: {
      get: forbidden,
      getOrCreate: forbidden,
      resolveWorkingDirectory: forbidden,
      store: forbidden,
      delete: forbidden,
    },
    threadStore: { get: forbidden },
    messageStore: { getById: async () => ({ source: { connector: 'collective' } }) },
    collectiveContext: () => ({ resolvePublic: async () => binding }),
    memoryCuePromptService: { resolve: forbidden },
    freshnessStateStore: { get: forbidden },
  };
  const run = async (service: AgentService, override = {}, params = {}) => {
    const output: AgentMessage[] = [];
    for await (const message of invokeSingleCat({ ...deps, ...override } as Parameters<typeof invokeSingleCat>[0], {
      catId,
      service,
      userId: 'owner',
      threadId: 'public',
      isLastCat: true,
      ownerAuthProvenance: 'unknown',
      executionScope: 'collective-participation',
      a2aTriggerMessageId: 'origin',
      prompt: 'PRIVATE_CANARY',
      systemPrompt: 'PRIVATE_CANARY',
      sessionId: 'HOME_CANARY',
      ...params,
    }))
      output.push(message);
    return output;
  };
  const read = async () => {
    const app = Fastify();
    await app.register(sessionTranscriptRoutes, {
      sessionChainStore: chains,
      turnExecutionStore: executions,
      invocationRecordStore: { get: () => null },
      transcriptReader: new TranscriptReader({ dataDir: directory }),
      threadStore: { get: () => ({ id: 'public', createdBy: 'owner' }) } as never,
    });
    try {
      return await app.inject({
        method: 'GET',
        url: '/api/threads/public/invocations',
        headers: { 'x-cat-cafe-user': 'owner' },
      });
    } finally {
      await app.close();
    }
  };
  return { directory, chains, writer, executions, deps, run, home, read };
}

test('real public lane records its child, native session and transcript before success, preserving home identity', async (t) => {
  const f = await harness(t);
  let atProviderStart = 0;
  const nativeId = randomUUID();
  const output = await f.run({
    supportsToolExecutionPolicy: () => true,
    async *invoke(_prompt, options) {
      assert.equal(options?.sessionId, undefined);
      assert.equal(f.chains.getActive(catId, 'public', 'owner')?.id, f.home.id);
      atProviderStart = f.chains.getChain(catId, 'public', 'owner').filter((record) => record.id !== f.home.id).length;
      yield { type: 'session_init', catId, sessionId: nativeId, timestamp: Date.now() };
      yield { type: 'text', catId, content: 'PUBLIC_RESULT', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  });
  assert.equal(atProviderStart, 1, 'the real scoped node must already exist before provider execution');
  const scoped = f.chains.getChain(catId, 'public', 'owner').find((record) => record.id !== f.home.id);
  assert.ok(scoped);
  const child = output[0].turnInvocationId;
  assert.equal(scoped.scopedInvocation?.invocationId, child);
  assert.equal(scoped.cliSessionId, nativeId);
  assert.equal(scoped.status, 'sealed');
  assert.equal(f.chains.getActive(catId, 'public', 'owner')?.id, f.home.id);
  assert.equal((await f.executions.get(child!))?.status, 'succeeded');
  const reader = new TranscriptInvocationReader(new TranscriptReader({ dataDir: f.directory }));
  const restored = await reader.list(f.chains.getChain(catId, 'public', 'owner'), 10);
  assert.equal(restored.total, 1);
  assert.equal(restored.invocations[0].invocationId, child);
  const events = await reader.readInvocation([scoped], child!);
  assert.match(JSON.stringify(events.get(scoped.id)?.events), /PUBLIC_RESULT/);
  assert.doesNotMatch(JSON.stringify(events.get(scoped.id)?.events), /PRIVATE_CANARY|HOME_CANARY/);
  const metrics = output
    .filter((message) => message.type === 'system_info')
    .map((message) => JSON.parse(message.content!));
  assert.ok(
    metrics.some(
      (message) =>
        message.type === 'invocation_metrics' && message.kind === 'session_started' && message.sessionId === nativeId,
    ),
  );
});

for (const dependency of ['sessionChainStore', 'transcriptWriter', 'sessionSealer']) {
  test(`missing ${dependency} refuses the scoped provider before any execution`, async (t) => {
    const f = await harness(t);
    let calls = 0;
    const output = await f.run(
      {
        supportsToolExecutionPolicy: () => true,
        async *invoke() {
          calls++;
          yield { type: 'done', catId, timestamp: Date.now() };
        },
      },
      { [dependency]: undefined },
    );
    assert.equal(calls, 0);
    assert.match(JSON.stringify(output), /collective_session_owner_unavailable/);
    assert.equal((await f.executions.get(output[0].turnInvocationId!))?.status, 'failed');
  });
}

test('refresh reconstructs the real public child through the owner invocation API', async (t) => {
  const f = await harness(t);
  const output = await f.run({
    supportsToolExecutionPolicy: () => true,
    async *invoke() {
      yield { type: 'session_init', catId, sessionId: randomUUID(), timestamp: Date.now() };
      yield { type: 'text', catId, content: 'RELOAD_RESULT', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  });
  const response = await f.read();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().invocations[0].invocationId, output[0].turnInvocationId);
  assert.equal(response.json().invocations[0].status, 'done');
});

for (const failure of ['provider', 'missing-native', 'transcript', 'seal']) {
  test(`${failure} failure cannot claim scoped success or replace home resume custody`, async (t) => {
    const f = await harness(t);
    const override =
      failure === 'seal'
        ? {
            sessionSealer: {
              requestSeal: f.deps.sessionSealer.requestSeal.bind(f.deps.sessionSealer),
              finalize: async (input: { sessionId: string }) => {
                await f.deps.sessionSealer.finalize(input);
                return { sealed: true, clean: false };
              },
            },
          }
        : failure === 'transcript'
          ? {
              transcriptWriter: {
                appendDurableEvent: async () => {
                  throw new Error('fixture_disk_failure');
                },
              },
            }
          : {};
    const output = await f.run(
      {
        supportsToolExecutionPolicy: () => true,
        async *invoke() {
          if (failure === 'provider') throw new Error('fixture_provider_failure');
          if (failure !== 'missing-native')
            yield { type: 'session_init', catId, sessionId: randomUUID(), timestamp: Date.now() };
          yield { type: 'done', catId, timestamp: Date.now() };
        },
      },
      override,
    );
    const execution = await f.executions.get(output[0].turnInvocationId!);
    assert.equal(execution?.status, 'failed');
    assert.equal(f.chains.getActive(catId, 'public', 'owner')?.id, f.home.id);
    assert.ok(output.some((message) => message.type === 'error'));
    if (failure === 'seal') {
      const response = await f.read();
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        response.json().invocations[0].status,
        'error',
        'archived provider done must not override failed finalization',
      );
    }
  });
}

test('aborted public provider cannot publish a successful terminal even after emitting done', async (t) => {
  const f = await harness(t);
  const controller = new AbortController();
  const output = await f.run(
    {
      supportsToolExecutionPolicy: () => true,
      async *invoke() {
        yield { type: 'session_init', catId, sessionId: randomUUID(), timestamp: Date.now() };
        controller.abort(new Error('fixture_public_cancel'));
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    },
    {},
    { signal: controller.signal },
  );
  assert.ok(['interrupted', 'canceled'].includes((await f.executions.get(output[0].turnInvocationId!))!.status));
  assert.equal(
    f.chains.getChain(catId, 'public', 'owner').find((record) => record.scopedInvocation)?.sealReason,
    'scoped_cancel',
  );
  assert.equal(f.chains.getActive(catId, 'public', 'owner')?.id, f.home.id);
});

test('actual adapter boundary hook records prepared public-only request against the scoped node, never home active', async (t) => {
  const f = await harness(t);
  const output = await f.run({
    supportsToolExecutionPolicy: () => true,
    async *invoke(prompt, options) {
      assert.ok(options?.beforeProviderLaunch);
      await options.beforeProviderLaunch({
        v: 1,
        message: { body: prompt },
        nativeInstructions: [{ body: options.systemPrompt! }],
        runtime: { provider: 'openai', carrier: 'scripted-test-adapter', model: 'fixture-model' },
        providerNativeVisibility: 'unsupported',
        tools: { finalSurface: 'unknown' },
      });
      yield { type: 'session_init', catId, sessionId: randomUUID(), timestamp: Date.now() };
      yield { type: 'text', catId, content: 'RECORDED_REQUEST', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  });
  const record = f.chains.getChain(catId, 'public', 'owner').find((item) => item.scopedInvocation)!;
  const reader = new TranscriptInvocationReader(new TranscriptReader({ dataDir: f.directory }));
  const pages = await reader.readInvocation([record], output[0].turnInvocationId!);
  const serialized = JSON.stringify(pages.get(record.id)?.events);
  assert.match(serialized, /request_generation_assembled/);
  assert.match(serialized, /public:origin/);
  assert.doesNotMatch(serialized, /PRIVATE_CANARY|HOME_CANARY/);
  assert.equal(f.chains.getActive(catId, 'public', 'owner')?.id, f.home.id);
});
