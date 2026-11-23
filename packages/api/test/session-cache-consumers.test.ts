import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatNavigationHeader } from '../src/domains/cats/services/agents/routing/navigation-context.js';
import { SessionCacheReadService } from '../src/domains/cats/services/session/cache/SessionCacheReadService.js';
import { RuntimeRoutingDispatchPreflight } from '../src/domains/routing-context/RoutingDispatchPreflightPort.js';

const warmth = {
  status: 'warm',
  estimated: true,
  source: 'usage_ttl',
  expiresAt: 2000000,
  contextTokens: 200000,
} as const;

test('actual-send preflight reads destination-thread cache facts without rerouting the explicit target', async () => {
  let readInput: unknown;
  const port = new RuntimeRoutingDispatchPreflight({
    now: () => 1000000,
    catalogSource: { load: async () => ({ catalogRevision: 'sha256:test', candidates: [] }) },
    preflightService: {
      preflight: async (input) => ({
        v: 1,
        ownerId: input.ownerId,
        observedAt: input.observedAt,
        resolverState: 'fresh',
        targets: [{ targetCatId: 'sonnet', disposition: 'allowed', reasons: [], alternatives: [] }],
      }),
    },
    sessionCache: {
      read: async (input) => {
        readInput = input;
        return [{ catId: 'sonnet', exists: true, warmth }];
      },
    },
  });
  const result = await port.preflight({ ownerId: 'owner-1', threadId: 'destination-thread', targetCatIds: ['sonnet'] });
  assert.deepEqual(readInput, {
    ownerId: 'owner-1',
    threadId: 'destination-thread',
    catIds: ['sonnet'],
    observedAt: 1000000,
  });
  assert.deepEqual(result.targets[0].cacheWarmth, warmth);
  assert.equal(result.targets[0].targetCatId, 'sonnet');
  assert.equal(result.targets[0].disposition, 'allowed');
});

test('member navigation exposes estimated warmth and unknown separately from execution liveness', () => {
  const header = formatNavigationHeader({
    tasks: [],
    currentCatId: 'codex',
    sessionCache: [
      { catId: 'sonnet', warmth },
      { catId: 'opus', warmth: { status: 'unknown', estimated: true, source: 'unavailable' } },
    ],
  });
  assert.match(header, /@sonnet.*预计缓存保留至.*200,000/);
  assert.doesNotMatch(header, /@opus/);
  assert.match(header, /未列出的成员：冷热未知/);
  assert.match(header, /按时间窗口估计.*未校验前缀变化/);
  assert.doesNotMatch(header, /\[processing\]/);
});

test('read service rejects a store response belonging to another owner or thread', async () => {
  const reader = new SessionCacheReadService({
    getActive: async () => ({
      userId: 'other-owner',
      threadId: 'other-thread',
      catId: 'sonnet',
      id: 'secret-session',
      status: 'active',
    }),
  });
  const [result] = await reader.read({
    ownerId: 'owner-1',
    threadId: 'thread-1',
    catIds: ['sonnet'],
    observedAt: 1000000,
  });
  assert.equal(result.exists, false);
  assert.equal(result.warmth.status, 'unknown');
  assert.equal(result.warmth.sessionId, undefined);
});

test('a live frozen model override invalidates warmth even while catalog defaults still match', async () => {
  const record = {
    id: 'session-1',
    catId: 'sonnet',
    userId: 'owner-1',
    threadId: 'thread-1',
    status: 'active',
    cliSessionId: 'native-1',
    compressionCount: 0,
    lastUsage: {
      cacheObservation: {
        nativeSessionId: 'native-1',
        runtime: 'anthropic:cli',
        model: 'sonnet',
        compressionCount: 0,
        requestStartedAt: 1000000,
        observedAt: 1000100,
        contextTokens: 200000,
        retentionMs: 3600000,
        retentionSource: 'usage_ttl',
        timeSource: 'invocation_start_lower_bound',
        confirmedWarmGapsMs: [],
      },
    },
  };
  const reader = new SessionCacheReadService({ getActive: async () => record }, 100, () => ({
    clientId: 'anthropic',
    carrier: 'cli',
    defaultModel: 'sonnet',
  }));
  const input = { ownerId: 'owner-1', threadId: 'thread-1', catIds: ['sonnet'], observedAt: 1000200 };
  const [defaultView] = await reader.read(input);
  assert.equal(defaultView.warmth.status, 'warm');
  assert.equal(defaultView.warmth.bindingSource, 'catalog_default');
  const [changed] = await reader.read({
    ...input,
    executionBindings: [{ catId: 'sonnet', runtime: 'anthropic:cli', model: 'haiku' }],
  });
  assert.equal(changed.warmth.status, 'unknown');
  assert.equal(changed.warmth.reason, 'runtime_or_model_changed');
  assert.equal(changed.warmth.bindingSource, 'frozen_execution');
});

test('a slow session store degrades to unknown within its read budget', async () => {
  const reader = new SessionCacheReadService({ getActive: () => new Promise(() => {}) }, 5);
  const [result] = await reader.read({ ownerId: 'owner-1', threadId: 'thread-1', catIds: ['sonnet'] });
  assert.equal(result.warmth.status, 'unknown');
  assert.equal(result.warmth.reason, 'read_unavailable');
});
