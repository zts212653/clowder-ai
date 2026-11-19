import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { symbols } from 'pino';
import './helpers/setup-cat-registry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { matterOpeningDirectory } from '../dist/domains/memory/matters/matter-opening-directory.js';
import { LOG_DIR_PATH, logger } from '../dist/infrastructure/logger.js';
import { fixture } from './helpers/matter-opening-cache-fixture.js';

for (const mode of ['cold', 'hot', 'rebuilt']) {
  test(`F332 ${mode}: the actual provider request receives a fresh directory independently of cold-only cues`, async () => {
    const prompts = [];
    const reads = [];
    let version = 1;
    const deps = {
      registry: {
        create: async () => ({ invocationId: `f332-${mode}`, callbackToken: 'test-token' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => (mode === 'hot' ? 'existing-native' : undefined),
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      matterMemoryService: {
        async catalog(actor, options) {
          reads.push({ actor, options });
          return {
            items: [
              {
                matterId: 'matter-actual',
                title: `Current matter v${version}`,
                revision: version,
                entryCount: 2,
                updatedAt: 1,
                hasThreadSource: true,
                description: '仅适用于社区现场；工程线程可继续获准工作。',
              },
              { matterId: 'matter-recent', title: 'A cross-thread example', revision: 1, entryCount: 1, updatedAt: 1 },
            ],
          };
        },
      },
    };
    deps.matterOpeningPrompt = ({ userId, catId, threadId, invocationId }) =>
      matterOpeningDirectory(deps.matterMemoryService, userId, catId, threadId, { invocationId });
    const service = {
      async *invoke(prompt, options) {
        prompts.push({ prompt, sessionId: options?.sessionId });
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
      ...(mode === 'rebuilt'
        ? {
            contextCapability: () => ({
              provider: 'openai',
              carrier: 'app_server',
              reportsRuntimeWindow: false,
              authoritativeUsage: false,
              usageTelemetry: 'unavailable',
              nativeWindowControl: false,
              nativeCompressionControl: false,
              observesCompression: true,
              reason: 'test',
            }),
            async *invokeWithContinuityPreflight(preflight) {
              const settled = await preflight.settle({
                evidence: { kind: 'started', runtimeSessionId: 'rebuilt-native' },
              });
              prompts.push({ prompt: settled.prompt });
              yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            },
          }
        : {}),
    };
    const params = {
      catId: 'opus',
      service,
      prompt: 'Continue the implementation',
      userId: 'owner',
      threadId: `matter-${mode}`,
      isLastCat: true,
      ownerAuthProvenance: 'strict',
      invocationOrigin: mode === 'hot' ? 'a2a' : 'interactive',
      ...(mode === 'rebuilt'
        ? { contextPromptFactory: async () => ({ prompt: 'rebuilt user context', promptMessageIds: [] }) }
        : {}),
    };
    for await (const _ of invokeSingleCat(deps, params)) {
    }
    version = 2;
    for await (const _ of invokeSingleCat(deps, params)) {
    }
    assert.equal(prompts.length, 2);
    assert.match(prompts[0].prompt, /Current matter v1/);
    assert.match(prompts[1].prompt, /Current matter v2/);
    assert.doesNotMatch(prompts[1].prompt, /Current matter v1/);
    assert.match(prompts[1].prompt, /cat_cafe_read_memory/);
    const directory = prompts[1].prompt.split('[事情目录]')[1].split('[/事情目录]')[0];
    const body = JSON.parse(directory.split('\n').find((line) => line.startsWith('{')));
    assert.deepEqual(
      body.groups.map(({ label, count }) => [label, count]),
      [
        ['含本线程出处的事情', 1],
        ['其他线程最近更新的事情', 1],
      ],
    );
    assert.equal(body.groups[0].items[0].contextHintLabel, '猫的归纳（r2；作者：未知）');
    assert.equal(body.groups[0].items[0].contextHint, '仅适用于社区现场；工程线程可继续获准工作。');
    assert.match(directory, /这是全家共用的记事本.*cat_cafe_remember 选 matter/);
    assert.match(directory, /readRef 交给 cat_cafe_read_memory/);
    assert.match(directory, /没列出的页.*cat_cafe_search_evidence/);
    assert.ok(reads.every(({ actor }) => actor.userId === 'owner' && actor.viewer.catId === 'opus'));
    assert.ok(reads.every(({ options }) => options.threadId === params.threadId));
    if (mode === 'hot') assert.equal(prompts[0].sessionId, 'existing-native');
    if (mode === 'rebuilt') assert.match(prompts[0].prompt, /rebuilt user context/);
    if (mode === 'rebuilt') {
      deps.matterMemoryService.catalog = async () => {
        throw new Error('opening-provider-boundary-fault');
      };
      for await (const _ of invokeSingleCat(deps, params)) {
      }
      assert.match(prompts[2].prompt, /当前目录不可用/);
      // The test logger uses multistream: flush its file destination before checking persistence.
      logger[symbols.streamSym].flushSync();
      const warning = readFileSync(join(LOG_DIR_PATH, 'api.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((line) => line.pid === process.pid && line.err?.message === 'opening-provider-boundary-fault');
      assert.ok(warning, 'the actual provider path must persist its failed directory diagnostic');
      assert.equal(warning.invocationId, 'f332-rebuilt');
      assert.equal(warning.threadId, params.threadId);
      assert.equal(warning.catId, params.catId);
      assert.equal(warning.stopReason, 'reader_rejected');
    }
  });
}

test('F332: the provider receives a revalidated aged directory and the refresh failure is persisted', async (t) => {
  const f = await fixture(t);
  await f.create('provider safe title', 'provider safe summary');
  const hidden = await f.create('provider PRIVATE title', 'provider PRIVATE summary');
  const prompts = [];
  let invocation = 0;
  const deps = {
    registry: {
      create: async () => ({ invocationId: `f332-cache-${++invocation}`, callbackToken: 'test-token' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    matterOpeningPrompt: ({ userId, catId, threadId, invocationId }) =>
      matterOpeningDirectory(f.service, userId, catId, threadId, { invocationId }),
  };
  const params = {
    catId: 'opus',
    service: {
      async *invoke(prompt) {
        prompts.push(prompt);
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    },
    prompt: 'Continue the accepted directory repair',
    userId: 'owner',
    threadId: 'here',
    isLastCat: true,
    ownerAuthProvenance: 'strict',
    invocationOrigin: 'interactive',
  };
  for await (const _ of invokeSingleCat(deps, params)) {
  }
  assert.match(prompts[0], /provider PRIVATE summary/);
  hidden.message.visibility = 'whisper';
  hidden.message.whisperTo = ['codex61-sol'];
  t.mock.method(f.service, 'catalog', async () => {
    throw Error('opening-provider-cache-fault');
  });
  for await (const _ of invokeSingleCat(deps, params)) {
  }
  assert.match(prompts[1], /缓存目录/);
  assert.match(prompts[1], /provider safe summary/);
  assert.doesNotMatch(prompts[1], /provider PRIVATE/);
  assert.ok(!prompts[1].includes(hidden.matterId));
  logger[symbols.streamSym].flushSync();
  const warning = readFileSync(join(LOG_DIR_PATH, 'api.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((line) => line.pid === process.pid && line.err?.message === 'opening-provider-cache-fault');
  assert.ok(warning);
  assert.equal(warning.invocationId, 'f332-cache-2');
  assert.equal(warning.threadId, 'here');
  assert.equal(warning.catId, 'opus');
  assert.equal(warning.stopReason, 'reader_rejected');
});
