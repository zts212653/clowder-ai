/**
 * F32-a Mock Agent Integration Test
 *
 * Verifies that a dynamically registered fourth cat ("mock-cat") works
 * through the entire system: catRegistry, AgentRegistry, catIdSchema(),
 * route schemas, config lookups, and AgentRouter routing.
 *
 * This is the primary verification of F32-a's design goal:
 * "A new cat can be plugged in via runtime registration, not hardcoding."
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

// Shared registry + helpers
import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';

// Populate built-in cats first
for (const [id, config] of Object.entries(CAT_CONFIGS)) {
  if (!catRegistry.has(id)) {
    catRegistry.register(id, config);
  }
}

/** Mock cat config (similar structure to built-in cats) */
const MOCK_CAT_CONFIG = {
  id: 'mock-cat',
  name: 'Mock Cat',
  displayName: '模拟猫',
  nickname: null,
  color: '#888888',
  clientId: 'mock',
  defaultModel: 'mock-v1',
  mentionPatterns: ['@mock-cat', '@模拟猫'],
  mcpSupport: false,
  roleDescription: 'A mock cat for testing dynamic registration',
  personality: 'Test personality',
};

describe('F32-a Mock Agent Integration', () => {
  beforeEach(() => {
    // Register mock cat (safe if already registered from a previous run)
    if (!catRegistry.has('mock-cat')) {
      catRegistry.register('mock-cat', MOCK_CAT_CONFIG);
    }
  });

  afterEach(() => {
    // Don't reset — other tests in the suite share the registry
  });

  // ── CatRegistry ───────────────────────────────────────────

  describe('CatRegistry: mock-cat registration', () => {
    test('mock-cat is registered and retrievable', () => {
      assert.ok(catRegistry.has('mock-cat'));
      const entry = catRegistry.getOrThrow('mock-cat');
      assert.equal(entry.config.displayName, '模拟猫');
      assert.equal(entry.config.clientId, 'mock');
    });

    test('getAllIds includes mock-cat alongside built-in cats', () => {
      const ids = catRegistry.getAllIds();
      assert.ok(ids.includes('opus'), 'should include opus');
      assert.ok(ids.includes('codex'), 'should include codex');
      assert.ok(ids.includes('gemini'), 'should include gemini');
      assert.ok(ids.includes('mock-cat'), 'should include mock-cat');
    });

    test('getAllConfigs includes mock-cat', () => {
      const configs = catRegistry.getAllConfigs();
      assert.ok('mock-cat' in configs);
      assert.equal(configs['mock-cat'].displayName, '模拟猫');
    });

    test('tryGet returns undefined for unregistered cat', () => {
      assert.equal(catRegistry.tryGet('nonexistent'), undefined);
    });

    test('getOrThrow throws for unregistered cat', () => {
      assert.throws(() => catRegistry.getOrThrow('nonexistent'), /Unknown cat ID/);
    });

    test('duplicate registration throws', () => {
      assert.throws(() => catRegistry.register('mock-cat', MOCK_CAT_CONFIG), /already registered/i);
    });
  });

  // ── catIdSchema ───────────────────────────────────────────

  describe('catIdSchema: dynamic validation', () => {
    test('accepts registered mock-cat', async () => {
      const { catIdSchema } = await import('@cat-cafe/shared');
      const schema = catIdSchema();
      const result = schema.safeParse('mock-cat');
      assert.ok(result.success, 'mock-cat should be valid');
    });

    test('accepts built-in cats', async () => {
      const { catIdSchema } = await import('@cat-cafe/shared');
      const schema = catIdSchema();
      for (const id of ['opus', 'codex', 'gemini']) {
        const result = schema.safeParse(id);
        assert.ok(result.success, `${id} should be valid`);
      }
    });

    test('rejects unregistered cat', async () => {
      const { catIdSchema } = await import('@cat-cafe/shared');
      const schema = catIdSchema();
      const result = schema.safeParse('nonexistent-cat');
      assert.ok(!result.success, 'nonexistent-cat should be invalid');
      assert.match(result.error.message, /Unknown cat ID/);
    });
  });

  // ── AgentRegistry ─────────────────────────────────────────

  describe('AgentRegistry: mock-cat service', () => {
    test('registers and retrieves mock agent service', async () => {
      const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
      const agentRegistry = new AgentRegistry();

      // Mock AgentService (minimal interface)
      const mockService = {
        invoke: async function* () {
          yield { type: 'text', catId: 'mock-cat', content: 'Hello from mock-cat!' };
          yield { type: 'done', catId: 'mock-cat' };
        },
      };

      agentRegistry.register('mock-cat', mockService);

      assert.ok(agentRegistry.has('mock-cat'));
      assert.strictEqual(agentRegistry.get('mock-cat'), mockService);
    });

    test('get() throws for unregistered cat', async () => {
      const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
      const agentRegistry = new AgentRegistry();
      assert.throws(() => agentRegistry.get('nonexistent'), /No AgentService registered/);
    });
  });

  // ── Config lookups ────────────────────────────────────────

  describe('Config lookups for mock-cat', () => {
    test('getCatContextBudget returns fallback for mock-cat', async () => {
      const { getCatContextBudget } = await import('../dist/config/cat-budgets.js');
      const budget = getCatContextBudget('mock-cat');
      assert.ok(budget.maxPromptTokens > 0, 'should have positive maxPromptTokens');
      assert.ok(budget.maxMessages > 0, 'should have positive maxMessages');
    });

    test('getSealConfig returns global fallback for mock-cat (unknown provider)', async () => {
      // F33 Phase 2: seal-thresholds.ts merged into session-strategy.ts
      const { getSealConfig } = await import('../dist/config/session-strategy.js');
      const config = getSealConfig('mock-cat');
      // mock-cat has provider='mock' which has no entry in DEFAULT_SEAL_BY_PROVIDER,
      // so it falls back to GLOBAL_DEFAULT
      assert.ok(config.sealThreshold > 0, 'should have positive sealThreshold');
      assert.ok(config.warnThreshold > 0, 'should have positive warnThreshold');
      assert.ok(config.turnBudget > 0, 'should have positive turnBudget');
    });

    test('getCatModel returns registry model for mock-cat', async () => {
      const { getCatModel } = await import('../dist/config/cat-models.js');
      // F32-a: getCatModel now falls back to catRegistry for dynamic cats
      const model = getCatModel('mock-cat');
      assert.equal(model, 'mock-v1', 'should return mock-cat defaultModel from registry');
    });

    test('getCatModel still throws for completely unknown cat', async () => {
      const { getCatModel } = await import('../dist/config/cat-models.js');
      assert.throws(() => getCatModel('nonexistent-cat'), /No model configured/);
    });
  });

  // ── SystemPromptBuilder ───────────────────────────────────

  describe('SystemPromptBuilder with mock-cat', () => {
    test('buildStaticIdentity includes mock-cat identity', async () => {
      const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
      const { createCatId } = await import('@cat-cafe/shared');
      const identity = buildStaticIdentity(createCatId('mock-cat'));
      assert.ok(identity.includes('模拟猫'), 'should include display name');
      assert.ok(identity.includes('mock'), 'should include provider');
    });

    test('buildInvocationContext includes mock-cat teammates', async () => {
      const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
      const { createCatId } = await import('@cat-cafe/shared');
      const context = buildInvocationContext({
        catId: createCatId('opus'),
        mode: 'independent',
        teammates: [createCatId('mock-cat')],
        mcpAvailable: false,
      });
      assert.ok(context.includes('模拟猫'), 'should list mock-cat as teammate');
    });
  });

  // ── A2A mention detection ─────────────────────────────────

  describe('A2A mentions detect mock-cat', () => {
    test('parseA2AMentions detects @模拟猫', async () => {
      const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
      const { createCatId } = await import('@cat-cafe/shared');
      const mentions = parseA2AMentions('@模拟猫 请确认这个改动', createCatId('opus'));
      assert.ok(
        mentions.some((m) => m === 'mock-cat'),
        'should detect mock-cat',
      );
    });

    test('parseA2AMentions detects @mock-cat', async () => {
      const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
      const { createCatId } = await import('@cat-cafe/shared');
      const mentions = parseA2AMentions('@mock-cat please review', createCatId('opus'));
      assert.ok(
        mentions.some((m) => m === 'mock-cat'),
        'should detect mock-cat',
      );
    });
  });

  // ── ContextAssembler ──────────────────────────────────────

  describe('ContextAssembler with mock-cat messages', () => {
    test('formatMessage uses mock-cat display name', async () => {
      const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
      const msg = {
        id: 'msg-1',
        userId: 'user-1',
        catId: 'mock-cat',
        content: '你好世界',
        mentions: [],
        timestamp: new Date('2026-02-18T12:00:00Z').getTime(),
        threadId: 'thread-1',
        origin: 'stream',
      };
      const formatted = formatMessage(msg);
      assert.ok(formatted.includes('模拟猫'), 'should use mock-cat display name');
      assert.ok(formatted.includes('你好世界'), 'should include content');
    });
  });

  // ── Cats API route ────────────────────────────────────────

  describe('/api/cats route includes mock-cat', () => {
    test('GET /api/cats returns mock-cat in list', async () => {
      const Fastify = (await import('fastify')).default;
      const { catsRoutes } = await import('../dist/routes/cats.js');

      const app = Fastify();
      await app.register(catsRoutes);

      const res = await app.inject({ method: 'GET', url: '/api/cats' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const mockEntry = body.cats.find((c) => c.id === 'mock-cat');
      assert.ok(mockEntry, 'mock-cat should be in cats list');
      assert.equal(mockEntry.displayName, '模拟猫');
    });

    test('GET /api/cats/:id/status returns mock-cat status', async () => {
      const Fastify = (await import('fastify')).default;
      const { catsRoutes } = await import('../dist/routes/cats.js');

      const app = Fastify();
      await app.register(catsRoutes);

      const res = await app.inject({ method: 'GET', url: '/api/cats/mock-cat/status' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, 'mock-cat');
      assert.equal(body.displayName, '模拟猫');
    });
  });

  // ── Capabilities route ──────────────────────────────────

  describe('/api/capabilities includes mock-cat', () => {
    test('GET /api/capabilities returns board items with mock-cat in cats map', async () => {
      const Fastify = (await import('fastify')).default;
      const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

      const app = Fastify();
      await app.register(capabilitiesRoutes);

      const res = await app.inject({
        method: 'GET',
        url: '/api/capabilities',
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      // F041 re-open: response is now { items, catFamilies, projectPath }
      assert.ok(Array.isArray(body.items), 'response.items should be an array');
      assert.ok(typeof body.projectPath === 'string', 'response.projectPath should be a string');
      // Each MCP item's cats map should include mock-cat with a boolean
      for (const item of body.items) {
        if (item.type === 'mcp') {
          assert.ok('mock-cat' in item.cats, 'MCP items should include mock-cat in cats map');
        }
      }
    });
  });

  // ── Memory publish route ────────────────────────────────

  describe('memory-publish accepts mock-cat as actor', () => {
    test('POST /api/memory/publish accepts mock-cat actor', async () => {
      const Fastify = (await import('fastify')).default;
      const { memoryPublishRoutes } = await import('../dist/routes/memory-publish.js');

      // Minimal in-memory governance store mock
      const entries = new Map();
      const governanceStore = {
        get: (id) => entries.get(id),
        create: (id, actor) => {
          const entry = { id, status: 'draft', actor };
          entries.set(id, entry);
          return entry;
        },
        transition: (id, _action, actor) => {
          const entry = entries.get(id);
          entry.status = 'in_review';
          entry.actor = actor;
          return entry;
        },
      };

      const app = Fastify();
      await app.register(memoryPublishRoutes, { governanceStore });

      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/publish',
        payload: {
          entryId: 'test-entry-1',
          action: 'submit_review',
          actor: 'mock-cat',
        },
      });
      assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.equal(body.entryId, 'test-entry-1');
    });

    test('POST /api/memory/publish rejects unregistered cat as actor', async () => {
      const Fastify = (await import('fastify')).default;
      const { memoryPublishRoutes } = await import('../dist/routes/memory-publish.js');

      const governanceStore = {
        get: () => undefined,
        create: () => ({ id: 'x', status: 'draft' }),
        transition: () => ({ id: 'x', status: 'in_review' }),
      };

      const app = Fastify();
      await app.register(memoryPublishRoutes, { governanceStore });

      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/publish',
        payload: {
          entryId: 'test-entry-2',
          action: 'submit_review',
          actor: 'nonexistent-cat',
        },
      });
      assert.equal(res.statusCode, 400, 'unregistered cat should be rejected');
    });
  });
});
