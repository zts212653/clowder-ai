import '../../test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';

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
  return prompt.match(/<memory-cue[\s\S]*?<\/memory-cue>/)?.[0] ?? '';
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
  });

  test('serial and parallel consume one typed Entity result and emit the same cue segment without legacy duplication', async () => {
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
              }
            : { promptSegment: '', admittedOpportunityIds: [] };
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
      assert.ok(result.prompt.includes('<memory-cue v="1"'));
      assert.equal(result.prompt.includes('[entity-nudge]'), false, 'legacy nudge must not duplicate the Cue');
      assert.equal(result.nudgeEventCount, 1, 'typed Entity result must be produced once, including side effects');
      assert.equal(result.prompt.split('person:alden').length - 1, 1, 'the same entity must appear once in the prompt');
    }

    assert.equal(extractCueSegment(serial.prompt), extractCueSegment(parallel.prompt));

    const unresolved = await run(routeSerial, false);
    assert.equal(unresolved.prompt.includes('<memory-cue v="1"'), false);
    assert.equal(unresolved.prompt.includes('[entity-nudge]'), true, 'zero cue preserves the existing F260 nudge');
    assert.equal(unresolved.nudgeEventCount, 1);
  });
});
