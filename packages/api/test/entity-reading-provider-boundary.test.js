import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECALL_RESOLVER_FAMILIES } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../dist/domains/cats/services/session/context/PresentationLedger.js';
import { MemoryCueInvocationPromptService } from '../dist/domains/memory/cue/MemoryCueInvocationPromptService.js';
import { MemoryCuePlaneService } from '../dist/domains/memory/cue/MemoryCuePlaneService.js';
import { MemoryCueResolverRegistry } from '../dist/domains/memory/cue/MemoryCueResolverRegistry.js';
import { PersonEntityCueResolver } from '../dist/domains/memory/cue/resolvers/PersonEntityCueResolver.js';
import { EntityNudgeService } from '../dist/domains/memory/EntityNudgeService.js';
import { EntityRegistryStore } from '../dist/domains/memory/EntityRegistry.js';
import { _resetSharedNudgeState } from '../dist/domains/memory/entity-nudge-state.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';

function entity(id, withReading = false) {
  return {
    entityId: id,
    type: id.split(':')[0],
    canonicalName: id,
    aliases: [id.split(':')[1]],
    provenance: [
      {
        source: 'thread-message',
        threadId: 'source-thread',
        messageId: `source-${id}`,
        ...(withReading ? { sourcePath: `docs/stories/${id.split(':')[1]}.md`, note: `阅读用途：${id}` } : {}),
      },
    ],
    status: 'active',
    visibilityScope: 'workspace',
    updatedAt: '2026-11-15T00:00:00Z',
  };
}

function fixture(t, entries, privateIds = new Set(), validateCurrent) {
  _resetSharedNudgeState();
  const db = new Database(':memory:');
  applyMigrations(db);
  const registry = new EntityRegistryStore(db);
  registry.upsert(entries);
  t.after(() => {
    _resetSharedNudgeState();
    db.close();
  });
  const sourceCalls = [];
  const personResolver = new PersonEntityCueResolver(
    {
      async resolve({ entityId }) {
        sourceCalls.push(entityId);
        return privateIds.has(entityId)
          ? {
              title: entityId,
              summary: 'Owner-approved person memory is available.',
              anchor: `person-memory:${entityId}`,
              revision: 'sha256:private-v1',
              asOf: 1_785_600_000_000,
              visibility: 'owner_private',
              drillFamily: 'person_memory',
            }
          : null;
      },
    },
    registry,
  );
  const memoryCuePromptService = new MemoryCueInvocationPromptService({
    plane: new MemoryCuePlaneService(
      new MemoryCueResolverRegistry(
        RECALL_RESOLVER_FAMILIES.map((family) =>
          family === 'person_entity' ? personResolver : { family, resolverVersion: 1, resolve: async () => [] },
        ),
      ),
    ),
    createDrillHandle: ({ anchor }) => `handle:${anchor}`,
  });
  const resolutions = [];
  const resolve = memoryCuePromptService.resolve.bind(memoryCuePromptService);
  memoryCuePromptService.resolve = async (input) => {
    const result = await resolve(input);
    if (validateCurrent)
      result.presentationEnvelopes = result.presentationEnvelopes.map((envelope) => ({ ...envelope, validateCurrent }));
    resolutions.push({ seeds: input.seeds, envelopes: result.presentationEnvelopes.length });
    return result;
  };
  let sequence = 0;
  const messages = new Map();
  const accepted = [],
    attempted = [],
    events = [];
  const deps = {
    services: {},
    invocationDeps: {
      registry: {
        create: async () => ({ invocationId: `inv-${++sequence}`, callbackToken: `tok-${sequence}` }),
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
      memoryCuePromptService,
      apiUrl: 'http://127.0.0.1:3102',
      contextEpochOwner: {
        async resolve({ disposition }) {
          return {
            scopeKey: 'owner::opus::reading-thread',
            contextEpoch: 7,
            contextMode: 'cold',
            lastTransitionRef: 'fixture:epoch',
            consumedCompactionEventIds: [],
            transition: 'fresh',
            normalizedDisposition: disposition,
            healthSignals: [],
          };
        },
      },
      presentationLedger: new PresentationLedger(new InMemoryPresentationLedgerStore()),
    },
    messageStore: {
      append: async (message) => {
        const row = { id: `message-${++sequence}`, mentions: [], timestamp: Date.now(), ...message };
        messages.set(row.id, row);
        return row;
      },
      getById: async (id) => messages.get(id) ?? null,
      getRecent: async () => [],
      getMentionsFor: async () => [],
      getRecentMentionsFor: async () => [],
      getBefore: async () => [],
      getByThread: async () => [],
      getByThreadAfter: async () => [],
      getByThreadBefore: async () => [],
    },
    draftStore: { delete: async () => {}, touch: async () => {}, upsert: async () => {} },
    socketManager: { broadcastToRoom() {} },
    evidenceStore: { getDb: () => db },
  };
  return {
    db,
    registry,
    accepted,
    attempted,
    sourceCalls,
    events,
    resolutions,
    async run(strategy, beforeBoundary = (prompt) => prompt) {
      deps.services.opus = {
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
        async *invoke(prompt, options) {
          attempted.push(prompt);
          const body = beforeBoundary(prompt, attempted.length);
          await options.beforeProviderLaunch({
            v: 1,
            message: { body },
            nativeInstructions: [],
            runtime: {},
            tools: { finalSurface: 'unknown' },
            providerNativeVisibility: 'unknown',
          });
          accepted.push(body);
          yield { type: 'text', catId: 'opus', content: 'main reply continues', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      };
      for await (const event of strategy(
        deps,
        ['opus'],
        entries.map((row) => row.aliases[0]).join(' '),
        'owner',
        'reading-thread',
        { currentUserMessageId: 'current-message', frustrationAutoIssueEligible: true },
      ))
        events.push(event);
    },
    delivered: () =>
      db
        .prepare("SELECT entity_id FROM entity_nudge_events WHERE outcome = 'delivered'")
        .all()
        .map((row) => row.entity_id),
  };
}

for (const [name, strategy] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  test(`${name}: an entity change during asynchronous revalidation rebuilds and preserves the main reply`, async (t) => {
    const row = entity('person:concurrentreader', true);
    let validations = 0;
    const f = fixture(t, [row], new Set([row.entityId]), async () => {
      if (++validations === 2)
        await new Promise((resolve) =>
          setImmediate(() => {
            f.registry.upsert([{ ...row, status: 'retired' }], {
              source: 'owner-action',
              actorId: 'owner',
              reason: 'concurrent retirement',
              conflictPolicy: 'allow-update',
            });
            resolve();
          }),
        );
      return true;
    });
    await f.run(strategy);
    assert.ok(validations >= 2, 'mutation must occur during provider-boundary revalidation');
    assert.equal(f.attempted.length, 2);
    assert.equal(f.accepted.length, 1);
    assert.equal(f.accepted[0].includes('<recall-opportunity-pointer'), false);
    assert.equal(f.accepted[0].includes('docs/stories/concurrentreader.md'), false);
    assert.deepEqual(
      f.events.filter((event) => event.type === 'error'),
      [],
    );
    assert.deepEqual(f.delivered(), []);
  });

  test(`${name}: private cues and shared reading metadata consume one three-entity allowance`, async (t) => {
    const entries = ['combinedfirst', 'combinedsecond', 'combinedthird', 'combinedfourth'].map((id) =>
      entity(`person:${id}`, true),
    );
    const f = fixture(t, entries, new Set(entries.map((row) => row.entityId)));
    const detected = new EntityNudgeService(f.db).detectCandidates({
      text: entries.map((row) => row.aliases[0]).join(' '),
      threadId: 'reading-thread',
      ownerUserId: 'owner',
    });
    await f.run(strategy);
    assert.equal(f.accepted.length, 1);
    assert.equal((f.accepted[0].match(/<recall-opportunity-pointer/g) ?? []).length, 3);
    assert.deepEqual(
      f.delivered(),
      detected.nudges.slice(0, 3).map((row) => row.entityId),
    );
    assert.ok(!f.accepted[0].includes(`handle:person-memory:${detected.nudges[3].entityId}`));
  });

  test(`${name}: entity retirement retracts its reading pointer and resolved private cue together`, async (t) => {
    const row = entity('person:retiredreader', true);
    const f = fixture(t, [row], new Set([row.entityId]));
    await f.run(strategy, (prompt, attempt) => {
      if (attempt === 1)
        f.registry.upsert([{ ...row, status: 'retired' }], {
          source: 'owner-action',
          actorId: 'owner',
          reason: 'retire entity before sending',
          conflictPolicy: 'allow-update',
        });
      return prompt;
    });
    assert.ok(
      f.attempted[0].includes('<recall-opportunity-pointer'),
      JSON.stringify({ sources: f.sourceCalls, resolutions: f.resolutions }),
    );
    assert.ok(f.attempted[0].includes('docs/stories/retiredreader.md'));
    assert.equal(f.accepted.length, 1, 'main reply survives source refresh');
    assert.equal(
      f.accepted[0].includes('<recall-opportunity-pointer'),
      false,
      'retired entity must not leave its typed cue',
    );
    assert.doesNotMatch(f.accepted[0], /docs\/stories\/retiredreader.md/);
    assert.deepEqual(f.delivered(), []);
  });

  test(`${name}: typed-only entity cue removed from the prepared body never earns delivery or cooldown`, async (t) => {
    const row = entity('person:typedreader');
    const f = fixture(t, [row], new Set([row.entityId]));
    await f.run(strategy, () => 'prepared body replaced without the person cue');
    assert.ok(f.attempted[0].includes('<recall-opportunity-pointer'), 'fixture must actually resolve a private cue');
    assert.deepEqual(f.delivered(), []);
    assert.equal(f.accepted.length, 0, 'an arbitrary replacement must fail the exact-body fence');
    await f.run(strategy);
    assert.equal(f.accepted.length, 1);
    assert.match(f.accepted[0], /<recall-opportunity-pointer/);
    assert.deepEqual(f.delivered(), [row.entityId]);
  });

  test(`${name}: unprojectable people do not displace usable reading pointers from the shared cap`, async (t) => {
    const empty = ['emptyfirst', 'emptysecond', 'emptythird'].map((id) => entity(`person:${id}`));
    const readable = ['readfirst', 'readsecond', 'readthird', 'readfourth'].map((id) => entity(`cat:${id}`, true));
    const entries = [...empty, ...readable];
    const f = fixture(t, entries);
    const detected = new EntityNudgeService(f.db).detectCandidates({
      text: entries.map((row) => row.aliases[0]).join(' '),
      threadId: 'reading-thread',
      ownerUserId: 'owner',
    });
    assert.deepEqual(
      new Set(detected.nudges.slice(0, 3).map((nudge) => nudge.entityId)),
      new Set(empty.map((row) => row.entityId)),
    );
    const orderedReadable = detected.nudges.filter((nudge) => nudge.entityId.startsWith('cat:'));
    await f.run(strategy);
    assert.equal(f.accepted.length, 1);
    for (const row of orderedReadable.slice(0, 3)) assert.ok(f.accepted[0].includes(row.provenance[0].sourcePath));
    assert.ok(
      !f.accepted[0].includes(orderedReadable[3].provenance[0].sourcePath),
      'one shared three-entity cap still holds',
    );
    assert.deepEqual(
      f.delivered(),
      orderedReadable.slice(0, 3).map((row) => row.entityId),
    );
  });
}
