import '../../test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../../dist/domains/cats/services/session/PresentationLedger.js';

const databases = [];

afterEach(async () => {
  const { _resetSharedNudgeState } = await import('../../dist/domains/memory/entity-nudge-state.js');
  _resetSharedNudgeState();
  while (databases.length > 0) databases.pop()?.close();
});

function createCapturingService(catId) {
  const prompts = [];
  return {
    prompts,
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
      prompts.push(prompt);
      yield { type: 'text', catId, content: 'done', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMessageStore() {
  let sequence = 0;
  const stored = new Map();
  return {
    append: async (message) => {
      const value = {
        id: `message-${++sequence}`,
        userId: message.userId ?? '',
        catId: message.catId ?? null,
        content: message.content ?? '',
        mentions: message.mentions ?? [],
        timestamp: message.timestamp ?? Date.now(),
        threadId: message.threadId ?? 'thread-alden',
        ...message,
      };
      stored.set(value.id, value);
      return value;
    },
    getById: async (id) => stored.get(id) ?? null,
    getRecent: async () => [],
    getMentionsFor: async () => [],
    getRecentMentionsFor: async () => [],
    getBefore: async () => [],
    getByThread: async () => [],
    getByThreadAfter: async () => [],
    getByThreadBefore: async () => [],
  };
}

function createRouteDeps(service, evidenceDb, memoryCuePromptService) {
  let sequence = 0;
  return {
    services: { opus: service },
    invocationDeps: {
      registry: {
        create: async () => ({ invocationId: `invocation-${++sequence}`, callbackToken: `token-${sequence}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
        consumeMentionRoutingFeedback: async () => null,
      },
      apiUrl: 'http://127.0.0.1:3102',
      memoryCuePromptService,
      contextEpochOwner: {
        async resolve({ disposition }) {
          return {
            scopeKey: 'owner-1::opus::thread-current',
            contextEpoch: 7,
            contextMode: 'cold',
            lastTransitionRef: 'fixture:fixed-epoch',
            consumedCompactionEventIds: [],
            transition: 'fresh',
            normalizedDisposition: disposition,
            healthSignals: [],
          };
        },
      },
      presentationLedger: new PresentationLedger(new InMemoryPresentationLedgerStore()),
    },
    messageStore: createMessageStore(),
    socketManager: { broadcastToRoom: () => {} },
    evidenceStore: { getDb: () => evidenceDb },
  };
}

function seedAlden() {
  const db = new Database(':memory:');
  databases.push(db);
  const applyPromise = import('../../dist/domains/memory/schema.js').then(({ applyMigrations }) => applyMigrations(db));
  return applyPromise.then(async () => {
    const { EntityRegistryStore } = await import('../../dist/domains/memory/EntityRegistry.js');
    new EntityRegistryStore(db).upsert([
      {
        entityId: 'person:alden',
        type: 'person',
        canonicalName: 'Alden',
        aliases: ['Alden'],
        provenance: [
          {
            source: 'thread-message',
            anchor: 'thread-other#message-owner-alden',
            threadId: 'thread-other',
            messageId: 'message-owner-alden',
          },
        ],
        visibilityScope: 'workspace',
        status: 'active',
        updatedAt: '2026-08-01T00:00:00Z',
      },
    ]);
    return db;
  });
}

function extractCueSegment(prompt) {
  return prompt.match(/<recall-opportunity-pointer[\s\S]*?<\/recall-opportunity-pointer>/)?.[0] ?? '';
}

describe('F287 D1 Alden golden journey', { concurrency: false }, () => {
  test('invocation prompt service binds a subject_seen seed to the real server scope', async () => {
    const { MemoryCueInvocationPromptService } = await import(
      '../../dist/domains/memory/cue/MemoryCueInvocationPromptService.js'
    );
    const { MemoryCuePlaneService } = await import('../../dist/domains/memory/cue/MemoryCuePlaneService.js');
    const { MemoryCueResolverRegistry } = await import('../../dist/domains/memory/cue/MemoryCueResolverRegistry.js');
    const { PersonEntityCueResolver } = await import(
      '../../dist/domains/memory/cue/resolvers/PersonEntityCueResolver.js'
    );
    const { OperationalPrecedentCueResolver } = await import(
      '../../dist/domains/memory/cue/resolvers/OperationalPrecedentCueResolver.js'
    );
    const { TasteCueResolver } = await import('../../dist/domains/memory/cue/resolvers/TasteCueResolver.js');
    const { ProfileCueResolver } = await import('../../dist/domains/memory/cue/resolvers/ProfileCueResolver.js');
    const { ProjectKnowledgeCueResolver } = await import(
      '../../dist/domains/memory/cue/resolvers/ProjectKnowledgeCueResolver.js'
    );

    const registry = new MemoryCueResolverRegistry([
      new PersonEntityCueResolver({
        async resolve(input) {
          assert.deepEqual(input, {
            ownerUserId: 'owner-1',
            threadId: 'thread-current',
            entityId: 'person:alden',
            matchedAlias: 'Alden',
            sourceMessageId: 'message-current',
          });
          return {
            title: 'Alden',
            summary: 'Relationship and interaction memory are available.',
            anchor: 'person-memory:person-alden',
            revision: 'sha256:alden-v1',
            asOf: 1_785_600_000_000,
            visibility: 'owner_private',
            drillFamily: 'person_memory',
          };
        },
      }),
      new OperationalPrecedentCueResolver({ resolve: async () => null }),
      new TasteCueResolver({ resolve: async () => null }),
      new ProfileCueResolver(),
      new ProjectKnowledgeCueResolver(),
    ]);
    const service = new MemoryCueInvocationPromptService({
      plane: new MemoryCuePlaneService(registry),
      createDrillHandle: (input) => `handle:${input.scope.invocationId}:${input.anchor}`,
    });

    const resolution = await service.resolve({
      seeds: [
        {
          kind: 'subject_seen',
          producer: 'entity_nudge',
          occurredAt: 1_785_600_000_000,
          payload: {
            entityId: 'person:alden',
            matchedAlias: 'Alden',
            sourceMessageId: 'message-current',
          },
        },
      ],
      serverScope: {
        ownerUserId: 'owner-1',
        threadId: 'thread-current',
        invocationId: 'invocation-real',
      },
      now: 1_785_600_000_001,
    });

    assert.match(resolution.promptSegment, /<memory-cue v="1"/);
    assert.match(resolution.promptSegment, /Alden/);
    assert.match(resolution.promptSegment, /handle:invocation-real:person-memory:person-alden/);
    assert.equal(resolution.admittedOpportunityIds.length, 1);
    assert.match(
      resolution.presentationEnvelopes[0].segments.pointer,
      /handle:invocation-real:person-memory:person-alden/,
    );
    assert.doesNotMatch(resolution.presentationEnvelopes[0].segments.pointer, /Alden|Relationship and interaction/);
  });

  test('serial and parallel consume one typed Entity result and emit the same T2 pointer without legacy duplication', async () => {
    const [{ routeSerial }, { routeParallel }] = await Promise.all([
      import('../../dist/domains/cats/services/agents/routing/route-serial.js'),
      import('../../dist/domains/cats/services/agents/routing/route-parallel.js'),
    ]);

    const { memoryCueOpportunityId } = await import(
      '../../dist/domains/memory/cue/MemoryCueInvocationPromptService.js'
    );
    const run = async (strategy, admitCue = true) => {
      const { _resetSharedNudgeState } = await import('../../dist/domains/memory/entity-nudge-state.js');
      _resetSharedNudgeState();
      const evidenceDb = await seedAlden();
      const capturing = createCapturingService('opus');
      const calls = [];
      const memoryCuePromptService = {
        async resolve(input) {
          calls.push(input);
          const seed = input.seeds[0];
          return admitCue
            ? {
                promptSegment: `<memory-cue v="1" cue-id="cue-alden" why-now="subject seen">\nTitle: ${seed.payload.matchedAlias}\nSource: ${seed.payload.entityId}\nDrill: person_memory handle-alden\n</memory-cue>`,
                admittedOpportunityIds: [memoryCueOpportunityId(seed, input.serverScope)],
                omittedOpportunityIds: [],
                deliveryReceipts: [
                  {
                    cueId: 'cue-alden',
                    event: {
                      cueId: 'cue-alden',
                      opportunityId: memoryCueOpportunityId(seed, input.serverScope),
                      scope: input.serverScope,
                      resolverFamily: 'person_entity',
                      sourceAnchor: 'person-memory:person-alden',
                      sourceRevision: 'revision-1',
                      axis: 'consumption',
                      consumptionOutcome: 'presented',
                      catalogVersion: 1,
                      resolverVersion: 1,
                      occurredAt: seed.occurredAt,
                    },
                  },
                ],
                presentationEnvelopes: [
                  {
                    candidate: {
                      subjectKey: 'memory-cue:person_entity:person-memory:person-alden',
                      asOf: { kind: 'version', value: 'revision-1' },
                      sourceTier: 'T2',
                      requested: 'pointer',
                      epistemicCeiling: 'pointer',
                    },
                    segments: {
                      pointer:
                        '<recall-opportunity-pointer v="1" opportunity-id="opportunity-alden">\nDrill: person_memory handle-alden\n</recall-opportunity-pointer>',
                    },
                    admission: {
                      opportunityId: memoryCueOpportunityId(seed, input.serverScope),
                      opportunityKind: 'recall',
                      producerOwner: 'entity_nudge',
                      consumerScope: { kind: 'invocation', ...input.serverScope },
                      entryVersion: 'recall-catalog:1:subject_seen:entity_nudge',
                      subjectKey: 'memory-cue:person_entity:person-memory:person-alden',
                      asOf: { kind: 'version', value: 'revision-1' },
                      sourceRefs: ['person-memory:person-alden'],
                      eligibleSurfaces: ['dynamic_context', 'pointer'],
                      presentationPolicyRef: 'F296.OpportunityPresentation',
                      tokenBudget: 300,
                      dedupeKey: `subject_seen\0${seed.payload.entityId}`,
                      expiresAt: input.now + 60_000,
                      invalidators: [{ owner: 'entity_nudge', ref: 'source_corrected' }],
                      epistemicCeiling: 'pointer',
                    },
                    receipt: {
                      cueId: 'cue-alden',
                      event: {
                        cueId: 'cue-alden',
                        opportunityId: memoryCueOpportunityId(seed, input.serverScope),
                        scope: input.serverScope,
                        resolverFamily: 'person_entity',
                        sourceAnchor: 'person-memory:person-alden',
                        sourceRevision: 'revision-1',
                        axis: 'consumption',
                        consumptionOutcome: 'presented',
                        catalogVersion: 1,
                        resolverVersion: 1,
                        occurredAt: seed.occurredAt,
                      },
                    },
                  },
                ],
              }
            : {
                promptSegment: '',
                admittedOpportunityIds: [],
                omittedOpportunityIds: [memoryCueOpportunityId(seed, input.serverScope)],
                deliveryReceipts: [],
                presentationEnvelopes: [],
              };
        },
      };
      const deps = createRouteDeps(capturing, evidenceDb, memoryCuePromptService);
      const options = {
        currentUserMessageId: 'message-current',
        frustrationAutoIssueEligible: true,
      };
      for await (const _event of strategy(deps, ['opus'], 'Alden is here', 'owner-1', 'thread-current', options)) {
        // drain real route assembly
      }
      const nudgeEventCount = evidenceDb.prepare('SELECT COUNT(*) AS count FROM entity_nudge_events').get().count;
      return { prompt: capturing.prompts[0], calls, nudgeEventCount };
    };

    const serial = await run(routeSerial);
    const parallel = await run(routeParallel);

    for (const result of [serial, parallel]) {
      assert.equal(result.calls.length, 1, 'one resolver call per actual cat invocation');
      assert.equal(result.calls[0].seeds.length, 1, 'EntityNudgeService result becomes one typed seed');
      assert.deepEqual(result.calls[0].seeds[0], {
        kind: 'subject_seen',
        producer: 'entity_nudge',
        occurredAt: result.calls[0].seeds[0].occurredAt,
        payload: {
          entityId: 'person:alden',
          matchedAlias: 'Alden',
          sourceMessageId: 'message-current',
        },
      });
      assert.deepEqual(result.calls[0].serverScope, {
        ownerUserId: 'owner-1',
        threadId: 'thread-current',
        invocationId: 'invocation-1',
      });
      assert.ok(result.prompt.includes('<recall-opportunity-pointer v="1"'));
      assert.equal(result.prompt.includes('<memory-cue v="1"'), false, 'T2 candidate body must not bypass the mapper');
      assert.equal(result.prompt.includes('[entity-nudge]'), false, 'legacy nudge must not duplicate the Cue');
      assert.equal(result.nudgeEventCount, 1, 'typed Entity result must be produced once, including side effects');
      assert.equal(result.prompt.includes('Title: Alden'), false, 'T2 pointer must not inline the candidate title');
    }

    assert.equal(extractCueSegment(serial.prompt), extractCueSegment(parallel.prompt));

    const unresolved = await run(routeSerial, false);
    assert.equal(unresolved.prompt.includes('<recall-opportunity-pointer'), false);
    assert.equal(unresolved.prompt.includes('[entity-nudge]'), false, 'untyped fallback must remain withheld');
    assert.equal(unresolved.nudgeEventCount, 1);
  });
});
