/**
 * F312: one route-level candidate must be presented independently to every
 * parallel consumer, then ledgered only from each adapter's exact request.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';

const { _resetSharedNudgeState } = await import('../dist/domains/memory/entity-nudge-state.js');

function createCapturingService(catId) {
  const prompts = [];
  return {
    prompts,
    async *invoke(prompt, options) {
      prompts.push(prompt);
      await options?.beforeProviderLaunch?.({
        v: 1,
        message: { body: prompt },
        nativeInstructions: [],
        runtime: {},
        tools: { finalSurface: 'unknown' },
        providerNativeVisibility: 'unknown',
      });
      yield { type: 'text', catId, content: `${catId} reply`, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createDeps(services, evidenceDb) {
  let sequence = 0;
  const storedById = new Map();
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++sequence}`, callbackToken: `tok-${sequence}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (message) => {
        const stored = { id: `msg-${++sequence}`, ...message, threadId: message.threadId ?? 'default' };
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: {
      delete: () => Promise.resolve(),
      touch: () => Promise.resolve(),
      upsert: () => Promise.resolve(),
    },
    socketManager: { broadcastToRoom: () => {} },
    evidenceStore: { getDb: () => evidenceDb },
  };
}

describe('F312 route-parallel entity nudge delivery', { concurrency: false }, () => {
  test('fanout gives Sol and Fable independent exact prompts, then suppresses only Fable’s repeat', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { EntityRegistryStore } = await import('../dist/domains/memory/EntityRegistry.js');
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    new EntityRegistryStore(db).upsert([
      {
        entityId: 'concept:未婚喵',
        type: 'concept',
        canonicalName: '未婚喵',
        aliases: ['未婚喵'],
        provenance: [{ source: 'manual', anchor: 'thread-f312-parallel-origin' }],
        visibilityScope: 'workspace',
        status: 'active',
        updatedAt: '2026-08-29T00:00:00Z',
      },
    ]);
    const sol = createCapturingService('codex-sol');
    const fable = createCapturingService('fable-5');
    const deps = createDeps({ 'codex-sol': sol, 'fable-5': fable }, db);

    try {
      for await (const _event of routeParallel(
        deps,
        ['codex-sol', 'fable-5'],
        '家属喵和未婚喵都在这里',
        'owner-1',
        'thread-f312-parallel',
        { currentUserMessageId: 'message-f312-parallel' },
      )) {
        // Drain both exact provider-boundary callbacks.
      }

      for (const service of [sol, fable]) {
        assert.equal(service.prompts.length, 1);
        assert.match(service.prompts[0], /\[entity-nudge\]/);
        assert.match(service.prompts[0], /未婚喵/);
      }
      const delivered = db
        .prepare(
          `SELECT cat_id, invocation_id, source_message_id, outcome
           FROM entity_nudge_events WHERE outcome = 'delivered' ORDER BY cat_id`,
        )
        .all();
      assert.deepEqual(
        delivered.map(({ cat_id, source_message_id, outcome }) => ({ cat_id, source_message_id, outcome })),
        [
          { cat_id: 'codex-sol', source_message_id: 'message-f312-parallel', outcome: 'delivered' },
          { cat_id: 'fable-5', source_message_id: 'message-f312-parallel', outcome: 'delivered' },
        ],
      );
      assert.ok(delivered.every((row) => typeof row.invocation_id === 'string' && row.invocation_id.length > 0));

      for await (const _event of routeParallel(deps, ['fable-5'], '再次提及未婚喵', 'owner-1', 'thread-f312-parallel', {
        currentUserMessageId: 'message-f312-fable-repeat',
      })) {
        // Drain the suppressed Fable retry.
      }
      assert.equal(fable.prompts.length, 2);
      assert.equal(fable.prompts[1].includes('[entity-nudge]'), false, 'only Fable is cooldown-suppressed');
      assert.deepEqual(
        db
          .prepare(
            `SELECT cat_id, source_message_id, outcome FROM entity_nudge_events
             WHERE outcome = 'recurrence_caught'`,
          )
          .all(),
        [
          {
            cat_id: 'fable-5',
            source_message_id: 'message-f312-fable-repeat',
            outcome: 'recurrence_caught',
          },
        ],
      );
    } finally {
      _resetSharedNudgeState();
      db.close();
    }
  });
});
