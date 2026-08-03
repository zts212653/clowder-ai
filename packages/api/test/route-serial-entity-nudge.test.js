/**
 * F260 AC-B8: route-serial entity nudge prompt injection — actual routeSerial integration.
 *
 * P1-3 R5 fix: Proves nudge context survives in the ACTUAL prompt passed to
 * invokeSingleCat, not just a hand-written simulation. Uses the same
 * createCapturingService pattern as route-serial-pingpong.test.js.
 *
 * Requirements:
 *   - deps.evidenceStore.getDb() returns a SQLite DB with seeded entities
 *   - options.frustrationAutoIssueEligible !== false (default)
 *   - Entity alias matches the user message text
 *   - Captured prompt includes [entity-nudge] block after assembly
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import Database from 'better-sqlite3';

const REPO_TEMPLATE_PATH = fileURLToPath(new URL('../../../cat-template.json', import.meta.url));

// Reset shared nudge singletons between tests (singleton holds stale DB otherwise)
const { _resetSharedNudgeState } = await import('../dist/domains/memory/entity-nudge-state.js');

function createCapturingService(catId, text) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, evidenceDb) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => ({
        id: `msg-${++counter}`,
        ...msg,
        userId: msg.userId ?? '',
        catId: msg.catId ?? null,
        content: msg.content ?? '',
        mentions: msg.mentions ?? [],
        timestamp: msg.timestamp ?? 0,
        threadId: msg.threadId ?? 'default',
      }),
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    // F260: wire evidenceStore so entity nudge hook activates
    evidenceStore: evidenceDb ? { getDb: () => evidenceDb } : undefined,
  };
}

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig(REPO_TEMPLATE_PATH));
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

function createEvidenceDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('F260 AC-B8: route-serial entity nudge prompt injection (actual routeSerial)', { concurrency: false }, () => {
  test('entity-nudge block appears in actual invokeSingleCat prompt', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    let evidenceDb;
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const { applyMigrations } = await import('../dist/domains/memory/schema.js');
      const { EntityRegistryStore } = await import('../dist/domains/memory/EntityRegistry.js');

      // Create in-memory DB with schema + seeded entity
      evidenceDb = createEvidenceDb();
      applyMigrations(evidenceDb);
      const store = new EntityRegistryStore(evidenceDb);
      store.upsert([
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual', anchor: 'thread-nudge-origin' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const opusService = createCapturingService('opus', '好的，我知道了');
      const deps = createMockDeps({ opus: opusService }, evidenceDb);

      // Run routeSerial with a message containing a registered entity
      for await (const _ of routeSerial(deps, ['opus'], '今天聊到了未婚喵', 'user1', 'thread-nudge-test', {
        thinkingMode: 'play',
      })) {
        // consume all events
      }

      // The capturing service records the actual prompt sent to invokeSingleCat
      assert.ok(opusService.calls.length >= 1, 'opus should be invoked at least once');
      const capturedPrompt = opusService.calls[0];
      const promptStr = typeof capturedPrompt === 'string' ? capturedPrompt : JSON.stringify(capturedPrompt);

      assert.ok(
        promptStr.includes('[entity-nudge]'),
        `actual invokeSingleCat prompt must contain [entity-nudge] block.\nPrompt excerpt: ${promptStr.slice(-500)}`,
      );
      assert.ok(promptStr.includes('未婚喵'), 'actual prompt must mention the detected entity');
      assert.ok(promptStr.includes('[/entity-nudge]'), 'actual prompt must contain closing entity-nudge tag');
    } finally {
      _resetSharedNudgeState();
      evidenceDb?.close();
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('entity-nudge block appears in incremental mode (budget path coverage)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    let evidenceDb;
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const { applyMigrations } = await import('../dist/domains/memory/schema.js');
      const { EntityRegistryStore } = await import('../dist/domains/memory/EntityRegistry.js');

      evidenceDb = createEvidenceDb();
      applyMigrations(evidenceDb);
      const store = new EntityRegistryStore(evidenceDb);
      store.upsert([
        {
          entityId: 'concept:烁烁',
          type: 'concept',
          canonicalName: '烁烁',
          aliases: ['烁烁'],
          provenance: [{ source: 'manual', anchor: 'thread-budget-origin' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const opusService = createCapturingService('opus', '好的');
      const deps = createMockDeps({ opus: opusService }, evidenceDb);
      // Incremental mode requires BOTH currentUserMessageId AND deliveryCursorStore
      deps.deliveryCursorStore = {
        getCursor: () => null,
        getForThread: () => null,
        upsert: () => {},
      };

      for await (const _ of routeSerial(deps, ['opus'], '烁烁今天心情好', 'user1', 'thread-budget-inc', {
        thinkingMode: 'play',
        currentUserMessageId: 'msg-budget-test-1',
      })) {
        // consume
      }

      assert.ok(opusService.calls.length >= 1, 'opus invoked');
      const prompt =
        typeof opusService.calls[0] === 'string' ? opusService.calls[0] : JSON.stringify(opusService.calls[0]);
      assert.ok(prompt.includes('[entity-nudge]'), 'incremental path must include entity-nudge block');
      assert.ok(prompt.includes('烁烁'), 'incremental path must include detected entity');
    } finally {
      _resetSharedNudgeState();
      evidenceDb?.close();
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('lane-neutral proactive-memory carrier replaces the tool-prefilled registration block', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    let evidenceDb;
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const { applyMigrations } = await import('../dist/domains/memory/schema.js');

      evidenceDb = createEvidenceDb();
      applyMigrations(evidenceDb);
      const prepared = {
        context:
          '\n[proactive-memory-candidate]\n' +
          '以下仅为机械重复统计；未分类，也未判断重要性：\n' +
          '- 「Alden」: 2 threads / 3 messages\n' +
          '  ↳ thread-a#message-a | thread-b#message-b,message-c\n' +
          '[/proactive-memory-candidate]',
        candidates: [],
        claimIds: ['claim-serial'],
      };
      let finalized = 0;
      const opusService = createCapturingService('opus', '好的');
      const deps = createMockDeps({ opus: opusService }, evidenceDb);
      deps.proactiveMemoryNudgeService = {
        prepare: async (input) => {
          assert.deepEqual(input, {
            ownerUserId: 'user1',
            currentUserMessageId: 'message-current',
          });
          return prepared;
        },
        finalize: (received) => {
          assert.equal(received, prepared);
          finalized += 1;
          return 1;
        },
      };

      for await (const _ of routeSerial(deps, ['opus'], 'Alden', 'user1', 'thread-workspace', {
        thinkingMode: 'play',
        currentUserMessageId: 'message-current',
      })) {
        // consume
      }

      assert.equal(opusService.calls.length, 1);
      const prompt =
        typeof opusService.calls[0] === 'string' ? opusService.calls[0] : JSON.stringify(opusService.calls[0]);
      assert.equal(prompt.includes('[proactive-memory-candidate]'), true);
      assert.equal(prompt.includes('Alden'), true);
      assert.equal(prompt.includes('[registration-candidate]'), false);
      assert.equal(prompt.includes('propose_entity'), false);
      assert.equal(finalized, 1, 'claim finalizes only after the carrier joins the invocation prompt');
    } finally {
      _resetSharedNudgeState();
      evidenceDb?.close();
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
});

// ── P1 R7: computeContextBudget — table-driven pure function test ──
describe('F260 computeContextBudget (shared budget helper)', () => {
  test('table-driven: serial/parallel × incremental/legacy budget calculation', async () => {
    const { computeContextBudget, BUDGET_RESERVED_TOKENS } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );

    assert.equal(BUDGET_RESERVED_TOKENS, 200, 'reserved tokens constant');

    const cases = [
      // label, maxPromptTokens, maxContextTokens, systemPartsTokens, promptTokens, nudgeTokens, expected
      ['no nudge, ample budget', 200000, 160000, 15000, 500, 0, 160000],
      ['nudge deducts from budget', 200000, 160000, 15000, 500, 1000, 160000],
      ['nudge pushes below maxContext', 200000, 160000, 30000, 5000, 10000, 154800],
      ['nudge exhausts budget', 200000, 160000, 100000, 80000, 30000, 0],
      ['zero nudge tokens (empty string)', 4000, 3000, 1000, 500, 0, 2300],
      ['small budget with nudge', 4000, 3000, 1000, 500, 300, 2000],
      ['budget clamps to zero', 1000, 3000, 500, 400, 200, 0],
      ['maxContextTokens caps result', 50000, 5000, 1000, 500, 0, 5000],
    ];

    for (const [label, maxPrompt, maxContext, system, prompt, nudge, expected] of cases) {
      const result = computeContextBudget({
        maxPromptTokens: maxPrompt,
        maxContextTokens: maxContext,
        systemPartsTokens: system,
        promptTokens: prompt,
        nudgeTokens: nudge,
      });
      assert.equal(result, expected, `${label}: expected ${expected}, got ${result}`);
    }
  });
});
