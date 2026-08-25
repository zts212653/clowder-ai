/**
 * F296 B4a: context epoch is the presentation ledger's write fence.
 *
 * The ContextEpochStore CAS and generation retirement must be one Redis
 * operation. Presentation reserve/commit must independently prove that their
 * write epoch is still current, otherwise a late prompt can recreate the exact
 * generation the CAS just retired.
 *
 * Test Redis only: port 6398, never the 6399 sanctuary.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import Redis from 'ioredis';
import './helpers/setup-cat-registry.js';
import { artifact, intake } from './memory/asr-person-memory-contract-fixture.js';

const TEST_PREFIX = `test:f296-b4a-epoch-retirement:${Date.now()}:`;
const DEV_TEST_REDIS_URL = 'redis://localhost:6398';
const SANCTUARY_PORT = '6399';
const telemetryExporter = new InMemorySpanExporter();
const telemetryProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(telemetryExporter)],
});
trace.setGlobalTracerProvider(telemetryProvider);

function resolveTestRedisUrl(envUrl) {
  if (!envUrl) return DEV_TEST_REDIS_URL;
  try {
    if (new URL(envUrl).port === SANCTUARY_PORT) return DEV_TEST_REDIS_URL;
  } catch {
    return DEV_TEST_REDIS_URL;
  }
  return envUrl;
}

describe('F296 B4a: epoch-fenced presentation generation retirement', () => {
  /** @type {import('ioredis').default} */
  let redis;
  let epochStore;
  let ledgerStore;
  let PresentationLedgerKeys;
  let presentationLedgerScopeKey;
  let PresentationLedger;
  let invokeSingleCat;
  let available = false;
  let scopeSequence = 0;

  before(async () => {
    const redisUrl = resolveTestRedisUrl(process.env.REDIS_URL);
    assert.equal(redisUrl.includes('6399'), false, 'refusing to run against the 6399 sanctuary');
    redis = new Redis(redisUrl, { keyPrefix: TEST_PREFIX, lazyConnect: true, retryStrategy: () => null });
    try {
      await redis.connect();
    } catch {
      redis.disconnect();
      return;
    }

    const [
      { RedisContextEpochStore },
      { RedisPresentationLedgerStore },
      keys,
      ledgerKey,
      presentationLedgerModule,
      invocationModule,
    ] = await Promise.all([
      import('../dist/domains/cats/services/stores/redis/RedisContextEpochStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisPresentationLedgerStore.js'),
      import('../dist/domains/cats/services/stores/redis-keys/presentation-ledger-keys.js'),
      import('../dist/domains/cats/services/session/ledger-key.js'),
      import('../dist/domains/cats/services/session/PresentationLedger.js'),
      import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'),
    ]);
    epochStore = new RedisContextEpochStore(redis);
    ledgerStore = new RedisPresentationLedgerStore(redis);
    PresentationLedgerKeys = keys.PresentationLedgerKeys;
    presentationLedgerScopeKey = ledgerKey.presentationLedgerScopeKey;
    PresentationLedger = presentationLedgerModule.PresentationLedger;
    invokeSingleCat = invocationModule.invokeSingleCat;
    available = true;
  });

  after(async () => {
    if (redis?.status === 'ready') {
      const keys = await redis.keys(`${TEST_PREFIX}*`);
      if (keys.length > 0) {
        const transaction = redis.multi();
        for (const key of keys) {
          transaction.del(key.startsWith(TEST_PREFIX) ? key.slice(TEST_PREFIX.length) : key);
        }
        await transaction.exec();
      }
      await redis.quit();
    }
    await telemetryProvider.shutdown();
    trace.disable();
  });

  function nextScope(label) {
    scopeSequence += 1;
    return `owner::codex::thread-${label}-${scopeSequence}`;
  }

  function epochRecord(scopeKey, contextEpoch, version) {
    return {
      scopeKey,
      contextEpoch,
      contextMode: 'cold',
      lastTransitionRef: `test:epoch-${contextEpoch}`,
      consumedCompactionEventIds: [],
      version,
      updatedAt: contextEpoch,
    };
  }

  function address(scopeKey, writeEpoch, entryField = 'projection') {
    return {
      scopeKey: presentationLedgerScopeKey({ scopeKey, contextEpoch: writeEpoch }),
      contextScopeKey: scopeKey,
      writeEpoch,
      entryField,
    };
  }

  function generationKey(scopeKey, epoch) {
    return PresentationLedgerKeys.generation(presentationLedgerScopeKey({ scopeKey, contextEpoch: epoch }));
  }

  async function seedEpoch(scopeKey, epoch = 1) {
    assert.equal(await epochStore.compareAndPut(epochRecord(scopeKey, epoch, 1), 0), true);
  }

  async function advanceEpoch(scopeKey, fromEpoch = 1, fromVersion = 1) {
    return epochStore.compareAndPut(epochRecord(scopeKey, fromEpoch + 1, fromVersion + 1), fromVersion);
  }

  function reserveInput(token = 'reservation-1') {
    return {
      token,
      nowMs: 1_000,
      expiresAtMs: 10_000,
      promptGenerationId: 'prompt-generation-1',
    };
  }

  function commitInput(token = 'reservation-1') {
    return {
      token,
      deliveredAtMs: 2_000,
      promptGenerationId: 'prompt-generation-1',
      providerAdapterId: 'codex/app_server',
    };
  }

  function parseSystemInfo(messages, type) {
    return messages.flatMap((message) => {
      if (message.type !== 'system_info' || !message.content) return [];
      try {
        const parsed = JSON.parse(message.content);
        return parsed.type === type ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }

  function cueResolution(invocationId) {
    const opportunityId = 'memory-opportunity-b4a';
    const cueId = 'memory-cue-b4a';
    const promptSegment = `<memory-cue v="1" cue-id="${cueId}">retirement race</memory-cue>`;
    const receipt = {
      cueId,
      event: {
        cueId,
        opportunityId,
        scope: { ownerUserId: 'owner-1', threadId: 'thread-f296-b4a', invocationId },
        resolverFamily: 'project_knowledge',
        sourceAnchor: 'feature:F296',
        sourceRevision: 'revision-b4a',
        axis: 'consumption',
        consumptionOutcome: 'presented',
        catalogVersion: 1,
        resolverVersion: 1,
        occurredAt: 1,
      },
    };
    return {
      promptSegment,
      admittedOpportunityIds: [opportunityId],
      omittedOpportunityIds: [],
      deliveryReceipts: [receipt],
      presentationEnvelopes: [
        {
          candidate: {
            subjectKey: receipt.event.sourceAnchor,
            asOf: { kind: 'version', value: receipt.event.sourceRevision },
            sourceTier: 'T2',
            requested: 'pointer',
            epistemicCeiling: 'pointer',
          },
          segments: { pointer: promptSegment },
          admission: {
            opportunityId,
            opportunityKind: 'recall',
            producerOwner: 'project_knowledge',
            consumerScope: {
              kind: 'invocation',
              ownerUserId: 'owner-1',
              threadId: 'thread-f296-b4a',
              invocationId,
            },
            entryVersion: 'test-recall:1',
            subjectKey: receipt.event.sourceAnchor,
            asOf: { kind: 'version', value: receipt.event.sourceRevision },
            sourceRefs: [receipt.event.sourceAnchor],
            eligibleSurfaces: ['dynamic_context', 'pointer'],
            presentationPolicyRef: 'F296.OpportunityPresentation',
            tokenBudget: 300,
            dedupeKey: opportunityId,
            expiresAt: Date.now() + 60_000,
            invalidators: [{ owner: 'project_knowledge', ref: 'source_corrected' }],
            epistemicCeiling: 'pointer',
          },
          receipt,
        },
      ],
    };
  }

  async function writeOpportunityScene(now) {
    const { buildAsrPersonMemoryDynamicScenes } = await import(
      '../dist/domains/signal-intake/AsrPersonMemorySceneBuilder.js'
    );
    const scene = buildAsrPersonMemoryDynamicScenes({
      intake: { ...intake, updatedAt: now - 10 },
      artifact,
      threadId: 'thread-f296-b4a',
      consumerCatId: 'codex',
      now,
    })[0];
    return {
      scene,
      source: {
        kind: 'message',
        threadId: 'thread-f296-b4a',
        sourceMessageId: 'message-b4a',
        authorUserId: 'owner-1',
        authorRole: 'owner',
        visibility: 'verified_live_owner_message',
      },
    };
  }

  function dispositionAuthority() {
    return {
      writeOpportunityTerminalLedger: {
        async recordTerminal() {},
        async recordInvalidated() {},
        async readLineageStates(_ownerUserId, dedupeLineages) {
          return new Map(dedupeLineages.map((lineage) => [lineage, { terminalGenerations: new Map() }]));
        },
      },
      writeOpportunityDeliveryStore: {
        async recordDelivered() {},
        async get() {
          return null;
        },
        async listInvocationOpportunityIds() {
          return [];
        },
        async purgeLineage() {
          return 0;
        },
      },
    };
  }

  it('reserve-before-CAS: advancing N to N+1 atomically deletes exact generation N', async (t) => {
    if (!available) return t.skip('redis unavailable');
    const scopeKey = nextScope('reserve-before-cas');
    await seedEpoch(scopeKey);
    assert.equal(await ledgerStore.reserve(address(scopeKey, 1), reserveInput()), 'reserved');
    assert.equal(await redis.exists(generationKey(scopeKey, 1)), 1);

    assert.equal(await advanceEpoch(scopeKey), true);
    assert.equal(await redis.exists(generationKey(scopeKey, 1)), 0);
  });

  it('CAS-before-reserve: a late reserve for N is fenced and cannot recreate N', async (t) => {
    if (!available) return t.skip('redis unavailable');
    const scopeKey = nextScope('cas-before-reserve');
    await seedEpoch(scopeKey);
    assert.equal(await advanceEpoch(scopeKey), true);

    assert.equal(await ledgerStore.reserve(address(scopeKey, 1), reserveInput()), 'context_epoch_retired');
    assert.equal(await redis.exists(generationKey(scopeKey, 1)), 0);
  });

  it('commit-before-CAS: a delivered generation is retired by the successful advance', async (t) => {
    if (!available) return t.skip('redis unavailable');
    const scopeKey = nextScope('commit-before-cas');
    await seedEpoch(scopeKey);
    const ledgerAddress = address(scopeKey, 1);
    assert.equal(await ledgerStore.reserve(ledgerAddress, reserveInput()), 'reserved');
    assert.equal(await ledgerStore.commit(ledgerAddress, commitInput()), 'committed');

    assert.equal(await advanceEpoch(scopeKey), true);
    assert.equal(await redis.exists(generationKey(scopeKey, 1)), 0);
  });

  it('CAS-before-commit: a late commit is bounded as context_epoch_retired and cannot revive N', async (t) => {
    if (!available) return t.skip('redis unavailable');
    const scopeKey = nextScope('cas-before-commit');
    await seedEpoch(scopeKey);
    const ledgerAddress = address(scopeKey, 1);
    assert.equal(await ledgerStore.reserve(ledgerAddress, reserveInput()), 'reserved');
    assert.equal(await advanceEpoch(scopeKey), true);

    assert.equal(await ledgerStore.commit(ledgerAddress, commitInput()), 'context_epoch_retired');
    assert.equal(await redis.exists(generationKey(scopeKey, 1)), 0);
  });

  it('CAS failure does not delete the exact generation', async (t) => {
    if (!available) return t.skip('redis unavailable');
    const scopeKey = nextScope('cas-failure');
    await seedEpoch(scopeKey);
    assert.equal(await ledgerStore.reserve(address(scopeKey, 1), reserveInput()), 'reserved');

    assert.equal(await epochStore.compareAndPut(epochRecord(scopeKey, 2, 1), 0), false);
    assert.equal(await redis.exists(generationKey(scopeKey, 1)), 1);
  });

  it('a successful advance deletes only N and preserves current/future sentinel generations', async (t) => {
    if (!available) return t.skip('redis unavailable');
    const scopeKey = nextScope('sentinels');
    await seedEpoch(scopeKey);
    await redis.hset(generationKey(scopeKey, 1), 'sentinel', 'retired');
    await redis.hset(generationKey(scopeKey, 2), 'sentinel', 'current');
    await redis.hset(generationKey(scopeKey, 3), 'sentinel', 'future');

    assert.equal(await advanceEpoch(scopeKey), true);
    assert.equal(await redis.exists(generationKey(scopeKey, 1)), 0);
    assert.equal(await redis.hget(generationKey(scopeKey, 2), 'sentinel'), 'current');
    assert.equal(await redis.hget(generationKey(scopeKey, 3), 'sentinel'), 'future');
  });

  it('a retired commit preserves provider output and existing receipt destinations without rerunning or omission', async (t) => {
    if (!available) return t.skip('redis unavailable');
    telemetryExporter.reset();
    const scopeKey = nextScope('invocation-race');
    await seedEpoch(scopeKey);
    const actualLedger = new PresentationLedger(ledgerStore);
    const commitOutcomes = [];
    const presentationLedger = {
      reserve: (...args) => actualLedger.reserve(...args),
      release: (...args) => actualLedger.release(...args),
      commit: async (...args) => {
        const outcome = await actualLedger.commit(...args);
        commitOutcomes.push(outcome);
        return outcome;
      },
    };
    const presentedMemoryReceipts = [];
    const memoryCuePromptService = {
      resolve: async ({ serverScope }) => cueResolution(serverScope.invocationId),
      recordPresented: async (receipts) => presentedMemoryReceipts.push(...receipts),
    };
    const now = Date.now();
    const scene = await writeOpportunityScene(now);
    let providerInvokeCount = 0;
    const service = {
      contextCapability: () => ({
        provider: 'openai',
        carrier: 'exec_json',
        reportsRuntimeWindow: true,
        authoritativeUsage: true,
        usageTelemetry: 'available',
        nativeWindowControl: true,
        nativeCompressionControl: true,
        observesCompression: true,
        reason: 'fixture',
      }),
      async *invoke(prompt) {
        providerInvokeCount += 1;
        assert.match(prompt, /memory-cue/);
        assert.match(prompt, /person-memory-write-opportunity/);
        assert.equal(await advanceEpoch(scopeKey), true, 'the provider wins the CAS-before-commit race');
        yield { type: 'text', catId: 'codex', content: 'substantive-once', timestamp: now + 1 };
        yield { type: 'done', catId: 'codex', timestamp: now + 2 };
      },
    };
    const deps = {
      ...dispositionAuthority(),
      registry: {
        create: async () => ({ invocationId: 'inv-f296-b4a', callbackToken: 'token-f296-b4a' }),
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
      contextEpochOwner: {
        resolve: async ({ disposition }) => ({
          scopeKey,
          contextEpoch: 1,
          contextMode: 'cold',
          lastTransitionRef: 'fixture:epoch-1',
          consumedCompactionEventIds: [],
          transition: 'scope_first_seen',
          normalizedDisposition: disposition,
          healthSignals: [],
        }),
      },
      presentationLedger,
      memoryCuePromptService,
    };
    const messages = [];
    for await (const message of invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'base prompt',
      userId: 'owner-1',
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-f296-b4a',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
      memoryCueOpportunitySeeds: [{ kind: 'subject_seen', producer: 'entity_nudge', occurredAt: 1, payload: {} }],
      asrPersonMemoryScenes: [scene],
      isLastCat: true,
    })) {
      messages.push(message);
    }

    assert.equal(providerInvokeCount, 1, 'the provider generation must not rerun');
    assert.equal(
      messages.filter((message) => message.type === 'text' && message.content === 'substantive-once').length,
      1,
      'the substantive provider message must still yield exactly once',
    );
    assert.ok(commitOutcomes.length >= 2, 'both dynamic projections must reach commit');
    assert.ok(
      commitOutcomes.every((outcome) => !outcome.committed && outcome.reason === 'context_epoch_retired'),
      `unexpected commit outcomes: ${JSON.stringify(commitOutcomes)}`,
    );
    assert.equal(presentedMemoryReceipts.length, 1, 'the existing presentation receipt destination remains active');
    assert.deepEqual(
      parseSystemInfo(messages, 'context_presentation_receipt').map((receipt) => receipt.outcome),
      ['presented'],
      'a post-provider retirement is not an omitted presentation',
    );
    assert.deepEqual(
      parseSystemInfo(messages, 'write_opportunity_presentation_receipt').map((receipt) => receipt.outcome),
      ['delivered'],
      'write-opportunity delivery evidence keeps its existing destination',
    );
    const telemetryAttributes = Object.assign(
      {},
      ...telemetryExporter.getFinishedSpans().map((span) => span.attributes),
    );
    assert.equal(
      telemetryAttributes['context_projection.ledger_outcome'],
      'context_epoch_retired',
      'the retired commit remains a bounded delivery terminal in telemetry',
    );
    assert.equal(await redis.exists(generationKey(scopeKey, 1)), 0, 'the retired generation must not revive');
  });
});
