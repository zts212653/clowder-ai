/**
 * F260 Phase B: EntityNudgeService — full pipeline integration test.
 *
 * Tests the orchestrated detect → build → cooldown → telemetry pipeline.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

let applyMigrations, EntityRegistryStore, EntityNudgeService, EntityNudgeEventStore;

function seedEntities(db, entities) {
  const store = new EntityRegistryStore(db);
  store.upsert(entities);
}

function seedDocAliases(db, aliases) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO doc_aliases
    (alias_norm, alias, doc_anchor, source, authority_tier, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const a of aliases) {
    stmt.run(
      a.aliasNorm ?? a.alias.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(),
      a.alias,
      a.docAnchor,
      a.source ?? 'doc-title',
      a.authorityTier ?? 'standard',
      a.createdAt ?? '2026-07-09T00:00:00Z',
    );
  }
}

const NOW_MS = Date.parse('2026-07-09T12:00:00Z');

describe('EntityNudgeService (full pipeline)', () => {
  let db;
  let service;

  beforeEach(async () => {
    const schemaMod = await import('../../dist/domains/memory/schema.js');
    applyMigrations = schemaMod.applyMigrations;

    const regMod = await import('../../dist/domains/memory/EntityRegistry.js');
    EntityRegistryStore = regMod.EntityRegistryStore;

    const svcMod = await import('../../dist/domains/memory/EntityNudgeService.js');
    EntityNudgeService = svcMod.EntityNudgeService;

    const storeMod = await import('../../dist/domains/memory/EntityNudgeEventStore.js');
    EntityNudgeEventStore = storeMod.EntityNudgeEventStore;

    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    service = new EntityNudgeService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns nudges for matching entities', () => {
    seedEntities(db, [
      {
        entityId: 'concept:未婚喵',
        type: 'concept',
        canonicalName: '未婚喵',
        aliases: ['未婚喵'],
        provenance: [{ source: 'manual', anchor: 'thread-story' }],
        visibilityScope: 'workspace',
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    const result = service.processInput({
      text: '今天聊到了未婚喵',
      threadId: 'thread-1',
      now: NOW_MS,
    });

    assert.equal(result.detectedCount, 1);
    assert.equal(result.nudges.length, 1);
    assert.equal(result.nudges[0].entityId, 'concept:未婚喵');
    assert.equal(result.nudges[0].storable, false);
    assert.equal(result.suppressedCount, 0);
  });

  it('returns empty for no matches', () => {
    const result = service.processInput({
      text: '今天天气不错',
      threadId: 'thread-1',
      now: NOW_MS,
    });

    assert.equal(result.detectedCount, 0);
    assert.equal(result.nudges.length, 0);
  });

  it('suppresses via cooldown on repeated input', () => {
    seedEntities(db, [
      {
        entityId: 'concept:未婚喵',
        type: 'concept',
        canonicalName: '未婚喵',
        aliases: ['未婚喵'],
        provenance: [{ source: 'manual', anchor: 'thread-story' }],
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    // First call — should deliver
    const r1 = service.processInput({
      text: '未婚喵',
      threadId: 'thread-1',
      now: NOW_MS,
    });
    assert.equal(r1.nudges.length, 1);

    // Second call same thread — should suppress (cooldown)
    const r2 = service.processInput({
      text: '又说到未婚喵了',
      threadId: 'thread-1',
      now: NOW_MS + 1000,
    });
    assert.equal(r2.detectedCount, 1, 'still detected');
    assert.equal(r2.nudges.length, 0, 'suppressed by cooldown');
    assert.equal(r2.suppressedCount, 1);
  });

  it('allows same entity in different thread', () => {
    seedEntities(db, [
      {
        entityId: 'concept:未婚喵',
        type: 'concept',
        canonicalName: '未婚喵',
        aliases: ['未婚喵'],
        provenance: [{ source: 'manual', anchor: 'thread-story' }],
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    service.processInput({
      text: '未婚喵',
      threadId: 'thread-1',
      now: NOW_MS,
    });

    const r2 = service.processInput({
      text: '未婚喵',
      threadId: 'thread-2',
      now: NOW_MS + 1000,
    });
    assert.equal(r2.nudges.length, 1, 'different thread should not be cooldown-suppressed');
  });

  it('handles mixed entity_registry + doc_aliases', () => {
    seedEntities(db, [
      {
        entityId: 'concept:未婚喵',
        type: 'concept',
        canonicalName: '未婚喵',
        aliases: ['未婚喵'],
        provenance: [{ source: 'manual', anchor: 'thread-story' }],
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);
    seedDocAliases(db, [
      {
        alias: '猫猫共犯伙伴-记忆篇',
        docAnchor: 'cat-pack-manifesto.md',
      },
    ]);

    const result = service.processInput({
      text: '未婚喵出现在猫猫共犯伙伴-记忆篇里',
      threadId: 'thread-1',
      now: NOW_MS,
    });

    assert.equal(result.detectedCount, 2);
    assert.equal(result.nudges.length, 2);
  });

  it('respects context suppression', () => {
    seedEntities(db, [
      {
        entityId: 'concept:未婚喵',
        type: 'concept',
        canonicalName: '未婚喵',
        aliases: ['未婚喵'],
        provenance: [{ source: 'manual', anchor: 'thread-story' }],
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    const result = service.processInput({
      text: '未婚喵',
      threadId: 'thread-1',
      contextAnchors: new Set(['concept:未婚喵']),
      now: NOW_MS,
    });

    assert.equal(result.detectedCount, 0, 'context-suppressed entities not counted');
    assert.equal(result.nudges.length, 0);
  });

  it('respects privacy gate', () => {
    seedEntities(db, [
      {
        entityId: 'concept:私密梗',
        type: 'concept',
        canonicalName: '私密梗',
        aliases: ['私密梗'],
        provenance: [{ source: 'manual', anchor: 'thread-diary-private' }],
        visibilityScope: 'private:user-owner',
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    const result = service.processInput({
      text: '说到私密梗呢',
      threadId: 'thread-other',
      ownerUserId: 'user-other',
      now: NOW_MS,
    });

    assert.equal(result.nudges.length, 0, 'private entity in non-authorized thread should not nudge');
  });

  it('delivers non-cooldown entities even when earlier candidates are suppressed (R4 cap fix)', () => {
    // Seed 4 entities — word0..word3
    seedEntities(
      db,
      Array.from({ length: 4 }, (_, i) => ({
        entityId: `concept:word${i}`,
        type: 'concept',
        canonicalName: `word${i}`,
        aliases: [`word${i}`],
        provenance: [{ source: 'manual', anchor: 'thread-story' }],
        updatedAt: '2026-07-09T00:00:00Z',
      })),
    );

    // First call: deliver word0, word1, word2 (they enter cooldown)
    service.processInput({
      text: 'word0 word1 word2 word3',
      threadId: 'thread-1',
      now: NOW_MS,
    });

    // Second call: word0-2 are in cooldown, word3 should still get through
    const r2 = service.processInput({
      text: 'word0 word1 word2 word3',
      threadId: 'thread-1',
      now: NOW_MS + 1000,
    });
    assert.ok(
      r2.nudges.some((n) => n.entityId === 'concept:word3'),
      'word3 should be delivered even though word0-2 are in cooldown',
    );
  });

  it('increments privacy_blocked counter when privacy gate suppresses (P2 fix)', () => {
    seedEntities(db, [
      {
        entityId: 'concept:私密梗',
        type: 'concept',
        canonicalName: '私密梗',
        aliases: ['私密梗'],
        provenance: [{ source: 'manual', anchor: 'thread-diary-private' }],
        visibilityScope: 'private:user-owner',
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    const result = service.processInput({
      text: '说到私密梗呢',
      threadId: 'thread-other',
      ownerUserId: 'user-other',
      now: NOW_MS,
    });

    // Privacy-blocked entities should be reported in result
    assert.equal(result.nudges.length, 0);
    assert.equal(result.privacyBlockedCount, 1, 'should report privacy-blocked count');
  });

  // ─── P1-2 fix: cooldown lifecycle across service instances ───

  it('suppresses via shared cooldown across service instances (cross-invocation)', async () => {
    seedEntities(db, [
      {
        entityId: 'concept:未婚喵',
        type: 'concept',
        canonicalName: '未婚喵',
        aliases: ['未婚喵'],
        provenance: [{ source: 'manual', anchor: 'thread-story' }],
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    // Simulate cross-invocation: share cooldown between two service instances
    const { EntityNudgeCooldown } = await import('../../dist/domains/memory/EntityNudgeCooldown.js');
    const sharedCooldown = new EntityNudgeCooldown();

    const service1 = new EntityNudgeService(db, sharedCooldown);
    const r1 = service1.processInput({
      text: '未婚喵',
      threadId: 'thread-1',
      now: NOW_MS,
    });
    assert.equal(r1.nudges.length, 1, 'first invocation should deliver');

    // Second service instance with SAME shared cooldown
    const service2 = new EntityNudgeService(db, sharedCooldown);
    const r2 = service2.processInput({
      text: '又说到未婚喵了',
      threadId: 'thread-1',
      now: NOW_MS + 1000,
    });
    assert.equal(r2.nudges.length, 0, 'second invocation should suppress via shared cooldown');
    assert.equal(r2.suppressedCount, 1, 'should report suppression');
  });

  // ─── F263 R9: renderability gate before delivery accounting ───

  it('coordinate-less nudges do not consume cap slots or create cooldown (F263 R9 regression)', () => {
    // Terra review repro: 3 concepts with no story coordinate + 1 valid cat.
    // DELIVERY_CAP = 3. Before fix: 3 concepts consume cap, valid cat truncated,
    // formatForPrompt returns empty, 2nd call cooldown-suppresses despite no injection.
    seedEntities(db, [
      {
        entityId: 'concept:alpha',
        type: 'concept',
        canonicalName: 'Alpha',
        aliases: ['alpha'],
        provenance: [{ source: 'manual' }], // no story coordinate
        visibilityScope: 'workspace',
        updatedAt: '2026-07-09T00:00:00Z',
      },
      {
        entityId: 'concept:beta',
        type: 'concept',
        canonicalName: 'Beta',
        aliases: ['beta'],
        provenance: [{ source: 'manual' }], // no story coordinate
        visibilityScope: 'workspace',
        updatedAt: '2026-07-09T00:00:00Z',
      },
      {
        entityId: 'concept:gamma',
        type: 'concept',
        canonicalName: 'Gamma',
        aliases: ['gamma'],
        provenance: [{ source: 'manual' }], // no story coordinate
        visibilityScope: 'workspace',
        updatedAt: '2026-07-09T00:00:00Z',
      },
      {
        // R9 二刀①: cat entities are always self-describing — use feature entity
        // with valid story coordinate to test renderability gate.
        entityId: 'feature:gold',
        type: 'feature',
        canonicalName: 'Gold Feature',
        aliases: ['gold'],
        provenance: [{ source: 'manual', threadId: 'thread-story' }], // valid story coordinate
        visibilityScope: 'workspace',
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    const r1 = service.processInput({
      text: 'alpha beta gamma gold',
      threadId: 'thread-1',
      now: NOW_MS,
    });

    // Valid feature must survive — coordinate-less concepts must NOT steal its cap slot
    assert.equal(r1.nudges.length, 1, 'only the renderable nudge should survive');
    assert.equal(r1.nudges[0].entityId, 'feature:gold', 'the valid entity must reach delivery');

    // formatForPrompt must produce real output
    const formatted = EntityNudgeService.formatForPrompt(r1);
    assert.ok(formatted.includes('feature:gold'), 'valid nudge must render');
    assert.ok(formatted.includes('threadId=thread-story'), 'story coordinate must appear');

    // Second call: alpha must NOT be cooldown-suppressed (it was never delivered)
    const r2 = service.processInput({
      text: 'alpha again with gold',
      threadId: 'thread-1',
      now: NOW_MS + 1000,
    });
    // gold is cooldown-suppressed (it WAS delivered), but alpha must be suppressed
    // by renderability (not cooldown) — it has no story coordinate
    assert.equal(r2.nudges.length, 0, 'gold cooldown + alpha unrenderable = 0');
    // The key invariant: alpha was NOT recorded as delivered, so it's not cooldown-suppressed
    // — it's unrenderable. If it were erroneously in cooldown, the suppressedCount
    // breakdown would differ.
  });

  it('event-store-wired: no_story_coordinate records without throw and creates no cooldown (F263 R9 Terra regression)', () => {
    // Terra re-review: recordSuppressed({ reason: 'no_story_coordinate' }) throws
    // because 'no_story_coordinate' was not in VALID_OUTCOMES. Production wires
    // sharedEventStore(evidenceDb), so this is a runtime crash, not a silent no-op.
    const eventStore = new EntityNudgeEventStore(db);
    const serviceWithStore = new EntityNudgeService(db, undefined, eventStore);

    seedEntities(db, [
      {
        entityId: 'concept:nocoord',
        type: 'concept',
        canonicalName: 'NoCoord',
        aliases: ['nocoord'],
        provenance: [{ source: 'manual' }], // no story coordinate
        visibilityScope: 'workspace',
        updatedAt: '2026-07-09T00:00:00Z',
      },
      {
        // R9 二刀①: cat entities are always self-describing — use feature entity
        entityId: 'feature:valid',
        type: 'feature',
        canonicalName: 'Valid Feature',
        aliases: ['validfeat'],
        provenance: [{ source: 'manual', threadId: 'thread-origin' }], // valid
        visibilityScope: 'workspace',
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    // Must not throw (the bug: VALID_OUTCOMES rejected 'no_story_coordinate')
    const r1 = serviceWithStore.processInput({
      text: 'nocoord and validfeat',
      threadId: 'thread-1',
      now: NOW_MS,
    });

    // Only the valid entity survives; unrenderable is suppressed
    assert.equal(r1.nudges.length, 1, 'only renderable nudge delivered');
    assert.equal(r1.nudges[0].entityId, 'feature:valid');
    assert.ok(r1.suppressedCount >= 1, 'unrenderable counted in suppressed');

    // Event store recorded the suppression with explicit outcome
    const suppEvents = eventStore.queryByOutcome('no_story_coordinate');
    assert.equal(suppEvents.length, 1, 'should persist no_story_coordinate event');
    assert.equal(suppEvents[0].entity_id, 'concept:nocoord');

    // Cooldown invariant: no_story_coordinate must NOT affect lastRenderedAt
    const lastRendered = eventStore.lastRenderedAt('concept:nocoord', 'thread-1');
    assert.equal(lastRendered, null, 'no_story_coordinate must not create phantom cooldown');

    // Valid entity's cooldown IS set (it was delivered)
    const validRendered = eventStore.lastRenderedAt('feature:valid', 'thread-1');
    assert.equal(validRendered, NOW_MS, 'delivered entity should have cooldown set');

    // Second call with fresh service instance — nocoord must still be rejected
    // by renderability, NOT cooldown. validfeat is cooldown-suppressed.
    const freshService = new EntityNudgeService(db, undefined, eventStore);
    const r2 = freshService.processInput({
      text: 'nocoord and validfeat again',
      threadId: 'thread-1',
      now: NOW_MS + 1000,
    });
    assert.equal(r2.nudges.length, 0, 'validfeat cooldown + nocoord unrenderable = 0');
  });

  it('proposal-backed cat:incident-guide reaches delivery through full pipeline (Terra P1)', () => {
    // Terra P1: operator-approved cat entities with proposal/callback-thread provenance
    // must survive the entire pipeline (detection → renderability → cooldown → cap → deliver).
    // Roster-only cats are filtered by isSelfDescribingMatch, but proposal-backed cats
    // carry real information value beyond common-knowledge roster identity.
    const eventStore = new EntityNudgeEventStore(db);
    const serviceWithStore = new EntityNudgeService(db, undefined, eventStore);

    seedEntities(db, [
      {
        entityId: 'cat:incident-guide',
        type: 'cat',
        canonicalName: 'incident-guide',
        aliases: ['incident-guide'],
        provenance: [
          { source: 'proposal', anchor: 'ep-7' },
          { source: 'callback-thread', threadId: 't-abc', messageId: 'm-1' },
        ],
        visibilityScope: 'workspace',
        status: 'active',
        updatedAt: '2026-07-09T00:00:00Z',
      },
    ]);

    const result = serviceWithStore.processInput({
      text: 'incident-guide 处理了事故',
      threadId: 'thread-pipeline',
      now: NOW_MS,
    });

    assert.equal(result.nudges.length, 1, 'proposal-backed cat should reach delivery');
    assert.equal(result.nudges[0].entityId, 'cat:incident-guide');

    // Cooldown set — proves it went through delivery, not suppression
    const cooldown = eventStore.lastRenderedAt('cat:incident-guide', 'thread-pipeline');
    assert.equal(cooldown, NOW_MS, 'delivered proposal-backed cat should have cooldown');
  });

  // ─── AC-B8: formatForPrompt ───

  describe('formatForPrompt (AC-B8)', () => {
    it('returns empty string when no nudges delivered', () => {
      const result = EntityNudgeService.formatForPrompt({
        nudges: [],
        detectedCount: 0,
        suppressedCount: 0,
        privacyBlockedCount: 0,
      });
      assert.equal(result, '');
    });

    it('returns entity-nudge block with nudge text lines', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual', anchor: 'thread-origin-story' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const result = service.processInput({
        text: '今天聊到了未婚喵',
        threadId: 'thread-1',
        now: NOW_MS,
      });

      const formatted = EntityNudgeService.formatForPrompt(result);
      assert.ok(formatted.includes('[entity-nudge]'), 'should have opening tag');
      assert.ok(formatted.includes('[/entity-nudge]'), 'should have closing tag');
      assert.ok(formatted.includes('未婚喵'), 'should contain the matched alias');
      assert.ok(formatted.includes('concept:未婚喵'), 'should contain the entity anchor');
      assert.ok(formatted.includes('provenance:'), 'structured provenance must remain visible after rendering');
      assert.ok(formatted.includes('source=manual'), 'rendered pointer should retain the provenance source');
      assert.ok(formatted.includes('anchor=thread-origin-story'), 'rendered pointer should expose the story anchor');
      assert.ok(!formatted.includes('anchor=concept:未婚喵'), 'renderer must not synthesize a self pointer');
      assert.ok(!formatted.startsWith('['), 'should start with newline before tag');
    });

    it('abstains instead of fabricating a registry/self pointer when no story coordinate exists (F263 R9)', () => {
      const formatted = EntityNudgeService.formatForPrompt({
        nudges: [
          {
            text: '📌 「F200」→ F200（文档）',
            kind: 'entity_nudge',
            docAnchor: 'F200',
            matchedAlias: 'F200',
            storable: false,
            indexable: false,
            provenance: [{ source: 'doc_aliases', anchor: 'F200' }],
            telemetry: {
              docAnchor: 'F200',
              sourceFamily: 'doc_aliases',
              aliasClass: 'doc',
              confidence: 0.5,
            },
          },
        ],
        detectedCount: 1,
        suppressedCount: 0,
        privacyBlockedCount: 0,
      });

      assert.equal(formatted, '');
    });

    it('renders a document source path instead of its registry table and self anchor (F263 R9)', () => {
      const formatted = EntityNudgeService.formatForPrompt({
        nudges: [
          {
            text: '📌 「Memory Lifecycle Repair」→ F263（文档）',
            kind: 'entity_nudge',
            docAnchor: 'F263',
            matchedAlias: 'Memory Lifecycle Repair',
            storable: false,
            indexable: false,
            provenance: [
              {
                source: 'doc-title',
                sourcePath: 'features/F263-memory-lifecycle-repair-and-metrics.md',
              },
            ],
            telemetry: {
              docAnchor: 'F263',
              sourceFamily: 'doc_aliases',
              aliasClass: 'doc',
              confidence: 0.5,
            },
          },
        ],
        detectedCount: 1,
        suppressedCount: 0,
        privacyBlockedCount: 0,
      });

      assert.ok(formatted.includes('sourcePath=features/F263-memory-lifecycle-repair-and-metrics.md'), formatted);
      assert.ok(!formatted.includes('source=doc_aliases'), formatted);
      assert.ok(!formatted.includes('anchor=F263'), formatted);
    });

    it('includes multiple nudge lines for multiple entities', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual', anchor: 'thread-origin-one' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:星星罐子',
          type: 'concept',
          canonicalName: '星星罐子',
          aliases: ['星星罐子'],
          provenance: [{ source: 'manual', anchor: 'thread-origin-two' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const result = service.processInput({
        text: '未婚喵和星星罐子',
        threadId: 'thread-1',
        now: NOW_MS,
      });

      const formatted = EntityNudgeService.formatForPrompt(result);
      assert.ok(formatted.includes('未婚喵'), 'should contain first entity');
      assert.ok(formatted.includes('星星罐子'), 'should contain second entity');
    });
  });

  // ── PR-5: AC-B5 event store integration ──

  describe('AC-B5: EntityNudgeEventStore integration', () => {
    let EntityNudgeEventStore;

    beforeEach(async () => {
      ({ EntityNudgeEventStore } = await import('../../dist/domains/memory/EntityNudgeEventStore.js'));
    });

    it('records delivered events in event store when wired', () => {
      const eventStore = new EntityNudgeEventStore(db);
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const svc = new EntityNudgeService(db, undefined, eventStore);
      const result = svc.processInput({
        text: '未婚喵',
        threadId: 'thread-event-test',
        now: NOW_MS,
      });

      assert.ok(result.nudges.length > 0, 'should detect at least one nudge');

      // Verify events were recorded
      const delivered = eventStore.queryByOutcome('delivered');
      assert.ok(delivered.length > 0, 'should have recorded delivered events');
      assert.equal(delivered[0].thread_id, 'thread-event-test');
      assert.equal(delivered[0].rendered_at, NOW_MS);
    });

    it('records suppressed events when cooldown filters nudges', () => {
      const eventStore = new EntityNudgeEventStore(db);
      seedEntities(db, [
        {
          entityId: 'concept:量子纠缠',
          type: 'concept',
          canonicalName: '量子纠缠',
          aliases: ['量子纠缠'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const svc = new EntityNudgeService(db, undefined, eventStore);

      // First call: delivers
      svc.processInput({
        text: '量子纠缠',
        threadId: 'thread-suppress-test',
        now: NOW_MS,
      });

      // Second call (same thread, within cooldown window): suppressed
      const result2 = svc.processInput({
        text: '量子纠缠',
        threadId: 'thread-suppress-test',
        now: NOW_MS + 1000,
      });

      assert.equal(result2.suppressedCount, 1, 'should suppress on cooldown');

      // Verify both delivered and suppressed events
      const delivered = eventStore.queryByOutcome('delivered');
      const suppressed = eventStore.queryByOutcome('recurrence_caught');
      assert.ok(delivered.length >= 1, 'at least one delivered event');
      assert.ok(suppressed.length >= 1, 'at least one suppressed event');
    });

    it('hydrates cooldown from event store on fresh service (restart continuity)', async () => {
      const { EntityNudgeCooldown } = await import('../../dist/domains/memory/EntityNudgeCooldown.js');
      const eventStore = new EntityNudgeEventStore(db);
      seedEntities(db, [
        {
          entityId: 'concept:量子猫',
          type: 'concept',
          canonicalName: '量子猫',
          aliases: ['量子猫'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      // First service instance: delivers and records in event store
      const svc1 = new EntityNudgeService(db, undefined, eventStore);
      const result1 = svc1.processInput({
        text: '量子猫',
        threadId: 'thread-restart',
        now: NOW_MS,
      });
      assert.ok(result1.nudges.length > 0, 'first instance should deliver');

      // Second service instance with FRESH cooldown (simulates process restart)
      // but shares the same event store (persistent DB)
      const freshCooldown = new EntityNudgeCooldown();
      const svc2 = new EntityNudgeService(db, freshCooldown, eventStore);
      const result2 = svc2.processInput({
        text: '量子猫',
        threadId: 'thread-restart',
        now: NOW_MS + 1000, // within 24h cooldown window
      });
      assert.equal(result2.nudges.length, 0, 'second instance should suppress via event store hydration');
      assert.equal(result2.suppressedCount, 1, 'should report suppression');
    });

    it('restart cooldown uses delivered time, not suppressed time (boundary)', async () => {
      const { EntityNudgeCooldown } = await import('../../dist/domains/memory/EntityNudgeCooldown.js');
      const eventStore = new EntityNudgeEventStore(db);
      seedEntities(db, [
        {
          entityId: 'concept:量子猫',
          type: 'concept',
          canonicalName: '量子猫',
          aliases: ['量子猫'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const HOUR = 60 * 60 * 1000;
      const DAY = 24 * HOUR;

      // t0: First service delivers the nudge
      const svc1 = new EntityNudgeService(db, undefined, eventStore);
      const r1 = svc1.processInput({ text: '量子猫', threadId: 'thread-boundary', now: NOW_MS });
      assert.ok(r1.nudges.length > 0, 'should deliver at t0');

      // t0+1h: Same service, cooldown suppresses (records recurrence_caught event)
      const r2 = svc1.processInput({ text: '量子猫', threadId: 'thread-boundary', now: NOW_MS + HOUR });
      assert.equal(r2.suppressedCount, 1, 'should suppress at t0+1h');

      // t0+24h+1ms: Fresh service (restart). Cooldown from DELIVERED at t0 has expired.
      // Must NOT be blocked by the suppressed event at t0+1h.
      const freshCooldown = new EntityNudgeCooldown();
      const svc2 = new EntityNudgeService(db, freshCooldown, eventStore);
      const r3 = svc2.processInput({ text: '量子猫', threadId: 'thread-boundary', now: NOW_MS + DAY + 1 });
      assert.ok(
        r3.nudges.length > 0,
        'should re-deliver at t0+24h+1ms — cooldown counts from delivered, not suppressed',
      );
    });

    it('resolved delivered events still count for cooldown (sibling of suppressed-time fix)', async () => {
      const { EntityNudgeCooldown } = await import('../../dist/domains/memory/EntityNudgeCooldown.js');
      const eventStore = new EntityNudgeEventStore(db);
      seedEntities(db, [
        {
          entityId: 'concept:量子猫',
          type: 'concept',
          canonicalName: '量子猫',
          aliases: ['量子猫'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      // t0: Deliver the nudge
      const svc1 = new EntityNudgeService(db, undefined, eventStore);
      const r1 = svc1.processInput({ text: '量子猫', threadId: 'thread-resolved', now: NOW_MS });
      assert.ok(r1.nudges.length > 0, 'should deliver at t0');

      // Resolve the delivered event to 'followed' (user acted on it)
      const events = eventStore.queryByOutcome('delivered');
      const thisEvent = events.find((e) => e.thread_id === 'thread-resolved');
      assert.ok(thisEvent, 'should have a delivered event');
      eventStore.resolveOutcome(thisEvent.event_id, 'followed', NOW_MS + 1000);

      // t0+1s: Fresh service (restart). The event is now 'followed', not 'delivered'.
      // Cooldown must still see it — resolved delivered is still a real delivery.
      const freshCooldown = new EntityNudgeCooldown();
      const svc2 = new EntityNudgeService(db, freshCooldown, eventStore);
      const r2 = svc2.processInput({ text: '量子猫', threadId: 'thread-resolved', now: NOW_MS + 1000 });
      assert.equal(r2.nudges.length, 0, 'should suppress — resolved delivered event still counts for cooldown');
      assert.equal(r2.suppressedCount, 1, 'should report suppression after restart with resolved event');
    });

    it('does not record events when event store not wired', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      // No event store passed — should still work without crash
      const svc = new EntityNudgeService(db);
      const result = svc.processInput({
        text: '未婚喵',
        threadId: 'thread-no-store',
        now: NOW_MS,
      });

      assert.ok(result.nudges.length > 0, 'should still detect nudges');
    });
  });

  // ─── F260 post-close regression: cap-truncated entities emit context-suppressed ───

  describe('cap-truncated entities (F260 regression)', () => {
    it('records context_suppressed event for entities truncated by delivery cap', async () => {
      const eventStoreMod = await import('../../dist/domains/memory/EntityNudgeEventStore.js');
      const EntityNudgeEventStore = eventStoreMod.EntityNudgeEventStore;
      const eventStore = new EntityNudgeEventStore(db);

      // Seed 5 entities so we exceed cap=3
      seedEntities(db, [
        {
          entityId: 'concept:概念A',
          type: 'concept',
          canonicalName: '概念A',
          aliases: ['概念A'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:概念B',
          type: 'concept',
          canonicalName: '概念B',
          aliases: ['概念B'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:概念C',
          type: 'concept',
          canonicalName: '概念C',
          aliases: ['概念C'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:概念D',
          type: 'concept',
          canonicalName: '概念D',
          aliases: ['概念D'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:概念E',
          type: 'concept',
          canonicalName: '概念E',
          aliases: ['概念E'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const svc = new EntityNudgeService(db, undefined, eventStore);
      const result = svc.processInput({
        text: '概念A和概念B还有概念C以及概念D加上概念E',
        threadId: 'thread-cap-test',
        now: NOW_MS,
      });

      // Delivery cap=3, so 2 entities should be truncated
      assert.equal(result.nudges.length, 3, 'delivery cap should limit to 3');

      // Check event store for context_suppressed records
      const allEvents = db
        .prepare(
          "SELECT * FROM entity_nudge_events WHERE thread_id = 'thread-cap-test' AND outcome = 'context_suppressed'",
        )
        .all();
      assert.ok(
        allEvents.length >= 2,
        `should have ≥2 context_suppressed events for cap-truncated entities (got ${allEvents.length})`,
      );
    });

    it('reports cap-truncated count in suppressedCount field', () => {
      // Seed 5 entities
      seedEntities(db, [
        {
          entityId: 'concept:词A',
          type: 'concept',
          canonicalName: '词A',
          aliases: ['词A'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:词B',
          type: 'concept',
          canonicalName: '词B',
          aliases: ['词B'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:词C',
          type: 'concept',
          canonicalName: '词C',
          aliases: ['词C'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:词D',
          type: 'concept',
          canonicalName: '词D',
          aliases: ['词D'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
        {
          entityId: 'concept:词E',
          type: 'concept',
          canonicalName: '词E',
          aliases: ['词E'],
          provenance: [{ source: 'manual', anchor: 'thread-story' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-09T00:00:00Z',
        },
      ]);

      const svc = new EntityNudgeService(db);
      const result = svc.processInput({
        text: '词A和词B还有词C以及词D加上词E',
        threadId: 'thread-cap-count',
        now: NOW_MS,
      });

      assert.equal(result.nudges.length, 3);
      // suppressedCount should include cap-truncated entities (not just cooldown)
      assert.ok(
        result.suppressedCount >= 2,
        `suppressedCount should include cap-truncated (got ${result.suppressedCount})`,
      );
    });
  });
});
