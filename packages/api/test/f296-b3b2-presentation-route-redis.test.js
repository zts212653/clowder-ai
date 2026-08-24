// F296 B3b-2 real surface proof: two API-instance ledgers share one persistent
// Redis keyspace, while provider prompt delivery remains the only commit point.
// Test Redis is pinned to 6398; the 6399 sanctuary is never consulted.
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Redis from 'ioredis';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { PresentationLedger } from '../dist/domains/cats/services/session/PresentationLedger.js';
import { RedisPresentationLedgerStore } from '../dist/domains/cats/services/stores/redis/RedisPresentationLedgerStore.js';

const TEST_REDIS_URL = 'redis://localhost:6398';
const TEST_PREFIX = `test:f296-b3b2-route:${Date.now()}:`;

const CODEX_EXEC = {
  provider: 'openai',
  carrier: 'exec_json',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: true,
  nativeCompressionControl: true,
  observesCompression: true,
  reason: 'fixture',
};

function fixedEpochOwner() {
  return {
    async resolve({ disposition }) {
      return {
        scopeKey: 'owner-1::codex::thread-f296-redis',
        contextEpoch: 11,
        contextMode: 'cold',
        lastTransitionRef: 'fixture:fixed-epoch',
        consumedCompactionEventIds: [],
        transition: 'fresh',
        normalizedDisposition: disposition,
        healthSignals: [],
      };
    },
  };
}

function cueResolution(invocationId) {
  const receipt = {
    cueId: 'cue-shared-redis',
    event: {
      cueId: 'cue-shared-redis',
      opportunityId: 'opportunity-shared-redis',
      scope: {
        ownerUserId: 'owner-1',
        threadId: 'thread-f296-redis',
        invocationId: 'producer-invocation',
      },
      resolverFamily: 'operational_precedent',
      sourceAnchor: 'feature:F296',
      sourceRevision: 'revision-1',
      axis: 'consumption',
      consumptionOutcome: 'presented',
      catalogVersion: 1,
      resolverVersion: 1,
      occurredAt: 1,
    },
  };
  return {
    promptSegment: 'legacy candidate title and summary must not bypass the typed pointer',
    admittedOpportunityIds: ['opportunity-shared-redis'],
    omittedOpportunityIds: [],
    deliveryReceipts: [receipt],
    presentationEnvelopes: [
      {
        candidate: {
          subjectKey: 'memory-cue:operational_precedent:feature:F296',
          asOf: { kind: 'version', value: 'revision-1' },
          sourceTier: 'T2',
          requested: 'pointer',
          epistemicCeiling: 'pointer',
        },
        segments: {
          pointer:
            '<recall-opportunity-pointer v="1" opportunity-id="opportunity-shared-redis">\nDrill: graph drill-handle\n</recall-opportunity-pointer>',
        },
        admission: {
          opportunityId: 'opportunity-shared-redis',
          opportunityKind: 'recall',
          producerOwner: 'entity_nudge',
          consumerScope: {
            kind: 'invocation',
            ownerUserId: 'owner-1',
            threadId: 'thread-f296-redis',
            invocationId,
          },
          entryVersion: 'recall-catalog:1:subject_seen:entity_nudge',
          subjectKey: 'memory-cue:operational_precedent:feature:F296',
          asOf: { kind: 'version', value: 'revision-1' },
          sourceRefs: ['feature:F296'],
          eligibleSurfaces: ['dynamic_context', 'pointer'],
          presentationPolicyRef: 'F296.OpportunityPresentation',
          tokenBudget: 300,
          dedupeKey: 'subject_seen\0feature:F296',
          expiresAt: Date.now() + 60_000,
          invalidators: [{ owner: 'entity_nudge', ref: 'source_corrected' }],
          epistemicCeiling: 'pointer',
        },
        receipt,
      },
    ],
  };
}

function deps(redis, invocationId, presented) {
  return {
    registry: {
      create: async () => ({ invocationId, callbackToken: `token-${invocationId}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    contextEpochOwner: fixedEpochOwner(),
    presentationLedger: new PresentationLedger(new RedisPresentationLedgerStore(redis)),
    memoryCuePromptService: {
      resolve: async () => cueResolution(invocationId),
      recordPresented: async (receipts) => presented.push(...receipts.map(({ cueId }) => cueId)),
    },
  };
}

async function invoke(dependencies, prompts) {
  const service = {
    contextCapability: () => CODEX_EXEC,
    async *invoke(prompt) {
      prompts.push(prompt);
      yield { type: 'text', catId: 'codex', content: 'delivered', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  for await (const _message of invokeSingleCat(dependencies, {
    catId: 'codex',
    service,
    prompt: 'base prompt',
    userId: 'owner-1',
    ownerAuthProvenance: 'unknown',
    threadId: 'thread-f296-redis',
    invocationOrigin: 'interactive',
    routeTopology: 'serial',
    memoryCueOpportunitySeeds: [{ kind: 'subject_seen', producer: 'entity_nudge', occurredAt: 1, payload: {} }],
    isLastCat: true,
  })) {
    // Exhaust the real provider-bound invocation.
  }
}

describe('F296 B3b-2 shared Redis ledger at the provider surface', () => {
  let redis;
  let available = false;

  before(async () => {
    assert.equal(new URL(TEST_REDIS_URL).port, '6398');
    redis = new Redis(TEST_REDIS_URL, { keyPrefix: TEST_PREFIX, lazyConnect: true, retryStrategy: () => null });
    try {
      await redis.connect();
      const { RedisContextEpochStore } = await import(
        '../dist/domains/cats/services/stores/redis/RedisContextEpochStore.js'
      );
      const epochStore = new RedisContextEpochStore(redis);
      assert.equal(
        await epochStore.compareAndPut(
          {
            scopeKey: 'owner-1::codex::thread-f296-redis',
            contextEpoch: 11,
            contextMode: 'cold',
            lastTransitionRef: 'fixture:fixed-epoch',
            consumedCompactionEventIds: [],
            version: 1,
            updatedAt: 1,
          },
          0,
        ),
        true,
      );
      available = true;
    } catch {
      redis.disconnect();
    }
  });

  after(async () => {
    if (redis?.status !== 'ready') return;
    const keys = await redis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) {
      const tx = redis.multi();
      for (const key of keys) tx.del(key.slice(TEST_PREFIX.length));
      await tx.exec();
    }
    await redis.quit();
  });

  it('suppresses a delivered projection in a second instance and keeps the record persistent', async (t) => {
    if (!available) return t.skip('redis unavailable');
    const prompts = [];
    const presented = [];

    await invoke(deps(redis, 'inv-f296-redis-a', presented), prompts);
    await invoke(deps(redis, 'inv-f296-redis-b', presented), prompts);

    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /<recall-opportunity-pointer/);
    assert.doesNotMatch(prompts[0], /legacy candidate title and summary/);
    assert.doesNotMatch(prompts[1], /<recall-opportunity-pointer/);
    assert.deepEqual(presented, ['cue-shared-redis']);

    const keys = await redis.keys(`${TEST_PREFIX}presentation-ledger:*`);
    assert.ok(keys.length > 0);
    for (const key of keys) {
      const unprefixedKey = key.slice(TEST_PREFIX.length);
      assert.equal(await redis.ttl(unprefixedKey), -1);
      assert.doesNotMatch(
        JSON.stringify(await redis.hgetall(unprefixedKey)),
        /legacy candidate|disposition|canonical truth|cue-shared-redis/,
      );
    }
  });
});
