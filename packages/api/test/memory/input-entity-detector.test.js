/**
 * F260 Phase B: InputEntityDetector — TDD tests.
 *
 * The InputEntityDetector scans human input text against both entity_registry
 * aliases and doc_aliases to produce structured nudge candidates. It is NOT
 * a reuse of resolveQuery (which is a search-query parser with no spans,
 * no confidence tiers, and unacceptable CJK false-positive rate on long text).
 *
 * Red lines:
 *   - M5: nudge only gives anchor + metadata, zero content paraphrasing
 *   - KD-8: no intent classification, only reports "this word has an archive"
 *   - KD-7: private entities in non-authorized threads = zero output
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/** Late-bound modules (loaded from dist/ after build) */
let applyMigrations;
let EntityRegistryStore;
let InputEntityDetector;

/** Seed entity_registry + entity_aliases via EntityRegistryStore.upsert */
function seedEntities(db, entities) {
  const store = new EntityRegistryStore(db);
  store.upsert(entities);
}

/** Seed doc_aliases directly (mirrors what mirrorDocAliases produces) */
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

function seedEvidenceDoc(db, { anchor, title, sourcePath }) {
  db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, source_path, updated_at)
     VALUES (?, 'feature', 'active', ?, ?, ?)`,
  ).run(anchor, title, sourcePath, NOW);
}

const NOW = '2026-07-09T12:00:00Z';

describe('InputEntityDetector', () => {
  /** @type {Database.Database} */
  let db;
  /** @type {import('../../dist/domains/memory/InputEntityDetector.js').InputEntityDetector} */
  let detector;

  beforeEach(async () => {
    const schemaMod = await import('../../dist/domains/memory/schema.js');
    applyMigrations = schemaMod.applyMigrations;

    const registryMod = await import('../../dist/domains/memory/EntityRegistry.js');
    EntityRegistryStore = registryMod.EntityRegistryStore;

    const detectorMod = await import('../../dist/domains/memory/InputEntityDetector.js');
    InputEntityDetector = detectorMod.InputEntityDetector;

    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    detector = new InputEntityDetector(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── AC-B1: regression fixture ───

  describe('core detection', () => {
    it('detects entity_registry alias in input text', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵', '未婚猫'],
          provenance: [{ source: 'manual', anchor: 'thread-diary' }],
          stance: 'endorsed',
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('今天聊到了未婚喵的话题');
      assert.ok(results.length >= 1, 'should detect at least one entity');
      const hit = results.find((r) => r.entityId === 'concept:未婚喵');
      assert.ok(hit, 'should match 未婚喵');
      assert.equal(hit.matchedAlias, '未婚喵');
      assert.equal(hit.type, 'concept');
      assert.equal(hit.sourceTable, 'entity_registry');
    });

    it('detects doc_aliases reference in input text (AC-B1: 猫猫共犯伙伴-记忆篇)', () => {
      seedDocAliases(db, [
        {
          alias: '猫猫共犯伙伴-记忆篇',
          docAnchor: 'cat-pack-manifesto.md',
          source: 'doc-title',
          authorityTier: 'primary',
        },
      ]);

      const results = detector.detect('你看过猫猫共犯伙伴-记忆篇吗');
      assert.ok(results.length >= 1, 'should detect doc alias');
      const hit = results.find((r) => r.docAnchor === 'cat-pack-manifesto.md');
      assert.ok(hit, 'should match cat-pack-manifesto.md');
      assert.equal(hit.matchedAlias, '猫猫共犯伙伴-记忆篇');
      assert.equal(hit.sourceTable, 'doc_aliases');
    });

    it('detects both entity_registry and doc_aliases in same input (union)', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual' }],
          updatedAt: NOW,
        },
      ]);
      seedDocAliases(db, [
        {
          alias: '猫猫共犯伙伴-记忆篇',
          docAnchor: 'cat-pack-manifesto.md',
        },
      ]);

      const results = detector.detect('未婚喵出现在猫猫共犯伙伴-记忆篇里');
      assert.equal(results.length, 2, 'should detect both sources');
      assert.ok(results.some((r) => r.entityId === 'concept:未婚喵'));
      assert.ok(results.some((r) => r.docAnchor === 'cat-pack-manifesto.md'));
    });

    it('returns empty for text with no matching aliases', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual' }],
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('今天天气不错啊');
      assert.equal(results.length, 0);
    });

    it('deduplicates by entity — same entity matched via multiple aliases returns once', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵', '未婚猫'],
          provenance: [{ source: 'manual' }],
          updatedAt: NOW,
        },
      ]);

      // Both aliases appear in text
      const results = detector.detect('未婚喵也叫未婚猫');
      assert.equal(results.length, 1, 'same entity should appear only once');
    });
  });

  // ─── Best-alias selection (local review P1) ───

  describe('best-alias selection (local review P1)', () => {
    it('picks canonical alias even when non-canonical alias matches first in SQL order', () => {
      // aliases in non-canonical-first order (simulating SQL row order)
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚猫', '未婚喵'], // non-canonical first!
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // Both aliases in text — canonical should be picked regardless of SQL order
      const results = detector.detect('未婚喵也叫未婚猫');
      assert.equal(results.length, 1);
      assert.equal(results[0].matchedAlias, '未婚喵', 'canonical alias should be picked');
      assert.equal(results[0].confidence, 1.0, 'should get canonical confidence');
    });
  });

  // ─── Privacy block count (local review P2) ───

  describe('privacy block count (local review P2)', () => {
    it('counts one privacy block per entity even with multiple matching aliases', () => {
      seedEntities(db, [
        {
          entityId: 'concept:私密梗',
          type: 'concept',
          canonicalName: '私密梗',
          aliases: ['私密梗', '秘密梗'], // two aliases that both match
          provenance: [{ source: 'manual', anchor: 'thread-diary-private' }],
          stance: 'endorsed',
          visibilityScope: 'private:user-alice',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // Non-owner — both aliases match in text
      const results = detector.detect('私密梗也叫秘密梗', {
        threadId: 'thread-other',
        ownerUserId: 'user-bob',
      });
      assert.equal(results.length, 0, 'should be suppressed');
      assert.equal(detector.lastPrivacyBlockedCount, 1, 'should count one block per entity, not per alias');
    });
  });

  // ─── Confidence tiers ───

  describe('confidence', () => {
    it('canonical name match gets higher confidence than alias match', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵', '未婚猫'],
          provenance: [{ source: 'manual' }],
          updatedAt: NOW,
        },
      ]);

      const canonicalHit = detector.detect('未婚喵');
      const aliasHit = detector.detect('未婚猫');
      assert.ok(canonicalHit.length > 0);
      assert.ok(aliasHit.length > 0);
      assert.ok(
        canonicalHit[0].confidence >= aliasHit[0].confidence,
        `canonical confidence (${canonicalHit[0].confidence}) should be >= alias confidence (${aliasHit[0].confidence})`,
      );
    });
  });

  // ─── AC-B7: Privacy gate ───

  describe('privacy gate (AC-B7)', () => {
    it('suppresses private entities in non-authorized thread', () => {
      seedEntities(db, [
        {
          entityId: 'concept:私密梗',
          type: 'concept',
          canonicalName: '私密梗',
          aliases: ['私密梗'],
          provenance: [{ source: 'manual', anchor: 'thread-diary-private' }],
          stance: 'endorsed',
          visibilityScope: 'private:user-1',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // Without authorized threadId — should be suppressed
      const results = detector.detect('说到私密梗呢', {
        threadId: 'thread-other',
        ownerUserId: 'user-other',
      });
      assert.equal(results.length, 0, 'private entity should not appear in non-authorized thread');
    });

    it('shows private entities in authorized (owner) thread', () => {
      seedEntities(db, [
        {
          entityId: 'concept:私密梗',
          type: 'concept',
          canonicalName: '私密梗',
          aliases: ['私密梗'],
          provenance: [{ source: 'manual', anchor: 'thread-diary-private' }],
          stance: 'endorsed',
          visibilityScope: 'private:user-1',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // With matching ownerUserId — should show
      const results = detector.detect('说到私密梗呢', {
        ownerUserId: 'user-1',
      });
      assert.ok(results.length >= 1, 'private entity should appear for owner');
    });

    it('suppresses private:<owner> scoped entities in non-authorized thread (P1 fix)', () => {
      seedEntities(db, [
        {
          entityId: 'concept:私密梗2',
          type: 'concept',
          canonicalName: '私密梗2',
          aliases: ['私密梗2'],
          provenance: [{ source: 'manual', anchor: 'thread-diary-private' }],
          stance: 'endorsed',
          visibilityScope: 'private:user-owner-123',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // private:<owner> format — should be suppressed in non-authorized thread
      const results = detector.detect('说到私密梗2呢', {
        threadId: 'thread-other',
        ownerUserId: 'user-other',
      });
      assert.equal(results.length, 0, 'private:<owner> entity should not appear in non-authorized thread');
    });

    it('suppresses private:<owner> when caller ownerUserId does not match (R2-2 fix)', () => {
      seedEntities(db, [
        {
          entityId: 'concept:私密梗4',
          type: 'concept',
          canonicalName: '私密梗4',
          aliases: ['私密梗4'],
          provenance: [{ source: 'manual' }],
          stance: 'endorsed',
          visibilityScope: 'private:user-alice',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // user-bob tries to access user-alice's private entity (no threadId, no provenance anchors)
      const results = detector.detect('说到私密梗4呢', {
        ownerUserId: 'user-bob',
      });
      assert.equal(results.length, 0, 'mismatched ownerUserId should be suppressed');
    });

    it('shows private:<owner> scoped entities to owner (P1 fix)', () => {
      seedEntities(db, [
        {
          entityId: 'concept:私密梗3',
          type: 'concept',
          canonicalName: '私密梗3',
          aliases: ['私密梗3'],
          provenance: [{ source: 'manual', anchor: 'thread-diary-private' }],
          stance: 'endorsed',
          visibilityScope: 'private:user-owner-123',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // Owner access — should be visible
      const results = detector.detect('说到私密梗3呢', {
        ownerUserId: 'user-owner-123',
      });
      assert.ok(results.length >= 1, 'private:<owner> entity should appear for owner');
    });

    it('allows owner to see own private entity from a different thread (R3-3 fix)', () => {
      seedEntities(db, [
        {
          entityId: 'concept:owner-secret',
          type: 'concept',
          canonicalName: 'owner-secret',
          aliases: ['owner-secret'],
          provenance: [{ source: 'manual', anchor: 'thread-origin' }],
          stance: 'endorsed',
          visibilityScope: 'private:user-alice',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // Owner (user-alice) accesses from a DIFFERENT thread (not thread-origin)
      // Owner should still see their own entity regardless of thread mismatch
      const results = detector.detect('owner-secret is here', {
        threadId: 'thread-different',
        ownerUserId: 'user-alice',
      });
      assert.ok(results.length >= 1, 'owner should see their own private entity from any thread');
      assert.equal(results[0].entityId, 'concept:owner-secret');
    });

    it('workspace-scoped entities appear in any thread', () => {
      seedEntities(db, [
        {
          entityId: 'concept:公开梗',
          type: 'concept',
          canonicalName: '公开梗',
          aliases: ['公开梗'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('公开梗是大家都知道的', {
        threadId: 'any-thread',
      });
      assert.ok(results.length >= 1);
    });
  });

  // ─── Canonical name coverage (R3-1) ───

  describe('canonical name coverage (R3-1)', () => {
    it('detects entity by canonical name even when not in aliases array', () => {
      // Seed entity where canonical name is NOT in the aliases array
      // This simulates a caller who only provides alternate aliases
      seedEntities(db, [
        {
          entityId: 'concept:canonical-only',
          type: 'concept',
          canonicalName: 'TheCanonicalName',
          aliases: ['alt-alias-1', 'alt-alias-2'], // canonical NOT included
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // Should detect via canonical name even though it's not in entity_aliases
      const results = detector.detect('TheCanonicalName appears here');
      assert.ok(results.length >= 1, 'canonical name should be detected even when not in aliases');
      assert.equal(results[0].entityId, 'concept:canonical-only');
      assert.equal(results[0].confidence, 1.0, 'canonical name should get highest confidence');
    });

    it('canonical name detection does not duplicate when already in aliases', () => {
      seedEntities(db, [
        {
          entityId: 'concept:normal-entity',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵', '未婚猫'], // canonical IS included
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('未婚喵出现了');
      assert.equal(results.length, 1, 'should not duplicate when canonical is already in aliases');
      assert.equal(results[0].entityId, 'concept:normal-entity');
    });
  });

  // ─── Cross-source dedup (R4-10) ───

  describe('cross-source dedup (R4-10)', () => {
    it('deduplicates when same alias appears in both entity_registry and doc_aliases', () => {
      // Same alias text in both sources
      seedEntities(db, [
        {
          entityId: 'concept:feature-abc',
          type: 'feature',
          canonicalName: 'feature-abc',
          aliases: ['feature-abc'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);
      seedDocAliases(db, [
        {
          alias: 'feature-abc',
          docAnchor: 'feature-abc.md',
        },
      ]);

      const results = detector.detect('Check feature-abc for details');
      // Should return only 1 result (entity_registry wins, higher confidence)
      assert.equal(results.length, 1, 'same alias from both sources should be deduped');
      assert.equal(results[0].sourceTable, 'entity_registry', 'entity_registry should win over doc_aliases');
    });
  });

  // ─── AC-B4: Noise control ───

  describe('noise control (AC-B4)', () => {
    it('respects maxResults limit', () => {
      // Seed 5 entities
      seedEntities(
        db,
        Array.from({ length: 5 }, (_, i) => ({
          entityId: `concept:word${i}`,
          type: 'concept',
          canonicalName: `word${i}`,
          aliases: [`word${i}`],
          provenance: [{ source: 'manual' }],
          updatedAt: NOW,
        })),
      );

      const results = detector.detect('word0 word1 word2 word3 word4', { maxResults: 3 });
      assert.equal(results.length, 3, 'should respect maxResults=3');
    });

    it('filters entities already in context (context suppression)', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual' }],
          updatedAt: NOW,
        },
        {
          entityId: 'concept:新梗',
          type: 'concept',
          canonicalName: '新梗',
          aliases: ['新梗'],
          provenance: [{ source: 'manual' }],
          updatedAt: NOW,
        },
      ]);

      // 未婚喵 is already in context — should be suppressed
      const results = detector.detect('未婚喵和新梗都在这里', {
        contextAnchors: new Set(['concept:未婚喵']),
      });
      assert.equal(results.length, 1, 'context-suppressed entity should be filtered');
      assert.equal(results[0].entityId, 'concept:新梗');
    });
  });

  // ─── Result shape ───

  describe('result shape', () => {
    it('returns structured DetectedEntity with required fields', () => {
      seedEntities(db, [
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual', anchor: 'thread-diary' }],
          stance: 'endorsed',
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('未婚喵');
      assert.equal(results.length, 1);
      const r = results[0];

      // Required fields per spec
      assert.equal(typeof r.entityId, 'string');
      assert.equal(typeof r.matchedAlias, 'string');
      assert.equal(typeof r.type, 'string');
      assert.equal(typeof r.confidence, 'number');
      assert.equal(typeof r.sourceTable, 'string');
      assert.ok(['entity_registry', 'doc_aliases'].includes(r.sourceTable));

      // Provenance for rendering (AC-B2)
      assert.ok(r.provenance != null, 'should include provenance');
      assert.equal(r.stance, 'endorsed');
    });

    it('doc_aliases results have docAnchor instead of entityId', () => {
      seedDocAliases(db, [
        {
          alias: 'some-document-title',
          docAnchor: 'some-doc.md',
        },
      ]);

      const results = detector.detect('Check the some-document-title for details');
      assert.equal(results.length, 1);
      assert.equal(results[0].docAnchor, 'some-doc.md');
      assert.equal(results[0].sourceTable, 'doc_aliases');
    });

    it('abstains when a doc alias only repeats its self-describing anchor (F263 R9)', () => {
      seedDocAliases(db, [{ alias: 'F200', docAnchor: 'F200', source: 'feature-id' }]);

      assert.deepEqual(detector.detect('F200'), []);
    });

    it('hydrates a useful doc alias with its canonical source-path story coordinate (F263 R9)', () => {
      seedEvidenceDoc(db, {
        anchor: 'F263',
        title: 'Memory Lifecycle Repair & Metrics',
        sourcePath: 'features/F263-memory-lifecycle-repair-and-metrics.md',
      });
      seedDocAliases(db, [
        {
          alias: 'Memory Lifecycle Repair & Metrics',
          docAnchor: 'F263',
          source: 'doc-title',
        },
      ]);

      const [result] = detector.detect('Read Memory Lifecycle Repair & Metrics before implementation');
      assert.ok(result);
      assert.deepEqual(result.provenance, [
        {
          source: 'doc-title',
          sourcePath: 'features/F263-memory-lifecycle-repair-and-metrics.md',
        },
      ]);
    });
  });

  // ─── F260 post-close regression: @ prefix routing mention filter ───

  describe('@ prefix routing mention filter (F260 regression)', () => {
    it('filters the exact Latin @fable5 routing sample from the operator report', () => {
      seedEntities(db, [
        {
          entityId: 'cat:fable-5',
          type: 'cat',
          canonicalName: '宪宪',
          aliases: ['fable5'],
          provenance: [{ source: 'F032 roster', anchor: 'cat-template.json' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      assert.deepEqual(detector.detect('@fable5 please review'), []);
    });

    it('filters out CJK entities whose alias matches via @mention (includes() path)', () => {
      // CJK aliases use includes() — @砚砚 contains 砚砚, so it matches without
      // the @ prefix filter. This is the actual production bug.
      seedEntities(db, [
        {
          entityId: 'cat:codex-sol',
          type: 'cat',
          canonicalName: '砚砚',
          aliases: ['砚砚', 'codex-sol'],
          provenance: [{ source: 'system' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // @砚砚 is routing syntax — CJK includes() would match 砚砚 inside @砚砚
      // but should be filtered because it's an @ routing mention
      const results = detector.detect('@砚砚 来 review 一下，未婚喵的事情');
      assert.ok(
        !results.some((r) => r.entityId === 'cat:codex-sol'),
        '@砚砚 should be filtered (routing syntax, not entity reference)',
      );
      assert.ok(
        results.some((r) => r.entityId === 'concept:未婚喵'),
        '未婚喵 should still be detected (not @ prefixed)',
      );
    });

    it('filters out entities when CJK alias is used as @mention', () => {
      seedEntities(db, [
        {
          entityId: 'cat:fable-5',
          type: 'cat',
          canonicalName: '宪宪',
          aliases: ['宪宪', 'fable5', 'fable-5'],
          provenance: [{ source: 'system' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // @宪宪 — CJK includes() would match 宪宪, but should be filtered
      const results = detector.detect('让 @宪宪 看看这个 PR');
      assert.equal(results.length, 0, '@宪宪 is routing syntax, entity should not be detected');
    });

    it('detects CJK concept entity normally when alias appears WITHOUT @ prefix', () => {
      // Use concept entity (not cat) to test @ routing filter in isolation —
      // cat entities are now always self-describing (R9 二刀①).
      seedEntities(db, [
        {
          entityId: 'concept:砚砚的帽子',
          type: 'concept',
          canonicalName: '砚砚的帽子',
          aliases: ['砚砚的帽子'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('砚砚的帽子很好看');
      assert.ok(
        results.some((r) => r.entityId === 'concept:砚砚的帽子'),
        'concept without @ should be detected',
      );
    });

    it('keeps CJK concept when both @mention AND standalone reference exist (gpt52 P1)', () => {
      seedEntities(db, [
        {
          entityId: 'concept:家属喵',
          type: 'concept',
          canonicalName: '家属喵',
          aliases: ['家属喵'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // Mixed case: @家属喵 (routing) + 家属喵 (legitimate reference) in same message
      const results = detector.detect('@家属喵 来一下，家属喵的事情');
      assert.ok(
        results.some((r) => r.entityId === 'concept:家属喵'),
        'concept should survive when alias appears both @-prefixed AND standalone',
      );
    });

    it('keeps non-CJK concept when @mention AND standalone coexist (gpt52 P1)', () => {
      seedEntities(db, [
        {
          entityId: 'concept:code-review',
          type: 'concept',
          canonicalName: 'code-review',
          aliases: ['code-review'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // Non-CJK mixed: @code-review (routing) + code-review (standalone)
      const results = detector.detect('@code-review 另外 code-review 刚修了这个');
      assert.ok(
        results.some((r) => r.entityId === 'concept:code-review'),
        'non-CJK concept should survive when standalone occurrence exists',
      );
    });

    it('operator regression fixture: @mention cats filtered, concept entities survive cap', () => {
      // operator's exact test scenario: message mentions @砚砚 and @宪宪 (routing)
      // plus 未婚喵 and 家属喵 (concept entities that should appear in nudge)
      seedEntities(db, [
        {
          entityId: 'cat:codex-sol',
          type: 'cat',
          canonicalName: '砚砚',
          aliases: ['砚砚', 'codex-sol'],
          provenance: [{ source: 'system' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'cat:fable-5',
          type: 'cat',
          canonicalName: '宪宪',
          aliases: ['宪宪', 'fable5', 'fable-5'],
          provenance: [{ source: 'system' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'concept:家属喵',
          type: 'concept',
          canonicalName: '家属喵',
          aliases: ['家属喵'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('让 @砚砚 来 review 一下 @宪宪 的 PR，未婚喵跟家属喵的事情', { maxResults: 3 });

      // @ mentions should be filtered out
      assert.ok(!results.some((r) => r.entityId === 'cat:codex-sol'), 'cat:codex-sol should be filtered');
      assert.ok(!results.some((r) => r.entityId === 'cat:fable-5'), 'cat:fable-5 should be filtered');
      // concept entities should survive
      assert.ok(
        results.some((r) => r.entityId === 'concept:未婚喵'),
        '未婚喵 should be in results',
      );
      assert.ok(
        results.some((r) => r.entityId === 'concept:家属喵'),
        '家属喵 should be in results',
      );
    });
  });

  // ─── F260 post-close regression: type value weight in cap sorting ───

  describe('cap sorting with type value weight (F260 regression)', () => {
    it('concept entities rank above doc/feature entities at same confidence tier', () => {
      // R9 二刀① makes cat entities always self-describing — test concept vs doc/feature instead.
      seedEntities(db, [
        {
          entityId: 'feature:f260',
          type: 'feature',
          canonicalName: 'F260',
          aliases: ['F260'],
          provenance: [{ source: 'system' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('未婚喵关于 F260 的讨论', { maxResults: 10 });
      const conceptIdx = results.findIndex((r) => r.entityId === 'concept:未婚喵');
      const featureIdx = results.findIndex((r) => r.entityId === 'feature:f260');
      assert.ok(conceptIdx >= 0 && featureIdx >= 0, 'both should be detected');
      assert.ok(conceptIdx < featureIdx, `concept (idx=${conceptIdx}) should rank above feature (idx=${featureIdx})`);
    });

    it('concept entities survive cap=3 over doc/feature entities', () => {
      seedEntities(db, [
        {
          entityId: 'feature:f260',
          type: 'feature',
          canonicalName: 'F260项目',
          aliases: ['F260项目'],
          provenance: [{ source: 'system' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'feature:f263',
          type: 'feature',
          canonicalName: 'F263项目',
          aliases: ['F263项目'],
          provenance: [{ source: 'system' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'concept:概念X',
          type: 'concept',
          canonicalName: '概念X',
          aliases: ['概念X'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'concept:概念Y',
          type: 'concept',
          canonicalName: '概念Y',
          aliases: ['概念Y'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // cap=3: 4 entities, concepts rank above features
      const results = detector.detect('F260项目和F263项目关于概念X和概念Y', { maxResults: 3 });
      assert.equal(results.length, 3);
      assert.ok(
        results.some((r) => r.entityId === 'concept:概念X'),
        '概念X should survive cap',
      );
      assert.ok(
        results.some((r) => r.entityId === 'concept:概念Y'),
        '概念Y should survive cap',
      );
    });
  });

  // ─── R9 二刀①: cat roster entities are type-self-evident ───

  describe('cat roster entities are type-self-evident (R9 二刀①)', () => {
    it('filters roster-only cat entities as self-describing (R9 二刀① Terra P1 regression)', () => {
      seedEntities(db, [
        {
          entityId: 'cat:codex-sol',
          type: 'cat',
          canonicalName: '砚砚',
          aliases: ['砚砚', 'codex-sol'],
          provenance: [{ source: 'F032 roster', anchor: 'cat-template.json' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      // roster-only cat entity — still filtered as self-describing
      const results = detector.detect('砚砚写的代码很好');
      assert.equal(results.length, 0, 'roster-only cat should be filtered as self-describing');
    });

    it('operator pressure test: 8-entity message — cats filtered, concepts survive cap', () => {
      // operator 2026-07-17: message with 8 entity words. Before fix, canonical-
      // confidence cats (1.0) crowded out alias-confidence concepts (0.7)
      // due to confidence-first sort. Now cats are filtered entirely.
      seedEntities(db, [
        {
          entityId: 'cat:codex',
          type: 'cat',
          canonicalName: 'codex',
          aliases: ['codex'],
          provenance: [{ source: 'F032 roster', anchor: 'cat-template.json' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'cat:opus',
          type: 'cat',
          canonicalName: 'opus',
          aliases: ['opus'],
          provenance: [{ source: 'F032 roster', anchor: 'cat-template.json' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'cat:gemini',
          type: 'cat',
          canonicalName: 'gemini',
          aliases: ['gemini'],
          provenance: [{ source: 'F032 roster', anchor: 'cat-template.json' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'concept:未婚喵',
          type: 'concept',
          canonicalName: '未婚喵',
          aliases: ['未婚喵'],
          provenance: [{ source: 'manual', threadId: 't1', messageId: 'm1' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
        {
          entityId: 'concept:家属喵',
          type: 'concept',
          canonicalName: '家属喵',
          aliases: ['家属喵'],
          provenance: [{ source: 'manual', threadId: 't2', messageId: 'm2' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('codex opus gemini 未婚喵 家属喵', { maxResults: 3 });
      // Zero cat entities in results
      assert.equal(
        results.filter((r) => r.type === 'cat').length,
        0,
        'all cat entities should be filtered as self-describing',
      );
      // Both concepts survive — they no longer compete with cats for cap slots
      assert.ok(
        results.some((r) => r.entityId === 'concept:未婚喵'),
        '未婚喵 should survive',
      );
      assert.ok(
        results.some((r) => r.entityId === 'concept:家属喵'),
        '家属喵 should survive',
      );
    });

    it('concept entities about cats are NOT filtered (only type=cat is self-describing)', () => {
      // A concept like "猫猫安全护栏" or "家属喵" is type=concept, not type=cat.
      // Only type=cat entities are self-describing.
      seedEntities(db, [
        {
          entityId: 'concept:猫猫安全护栏',
          type: 'concept',
          canonicalName: '猫猫安全护栏',
          aliases: ['猫猫安全护栏'],
          provenance: [{ source: 'manual' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('猫猫安全护栏很重要');
      assert.equal(results.length, 1, 'concept entity should NOT be filtered');
      assert.equal(results[0].entityId, 'concept:猫猫安全护栏');
    });

    it('proposal-backed cat entity is NOT filtered — has non-roster provenance (Terra P1)', () => {
      // operator-approved cat entities (e.g. cat:incident-guide) have proposal/callback-thread
      // provenance, not just roster/system. These carry real information value and MUST
      // reach delivery, unlike bare roster cats whose identity is common knowledge.
      seedEntities(db, [
        {
          entityId: 'cat:incident-guide',
          type: 'cat',
          canonicalName: 'incident-guide',
          aliases: ['incident-guide', '事故猫'],
          provenance: [
            { source: 'proposal', anchor: 'ep-7' },
            { source: 'callback-thread', threadId: 't-abc', messageId: 'm-1' },
          ],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('事故猫负责处理事故');
      assert.equal(results.length, 1, 'proposal-backed cat should NOT be filtered — has non-roster provenance');
      assert.equal(results[0].entityId, 'cat:incident-guide');
    });

    it('mixed provenance cat (roster + proposal) survives — proposal outweighs roster (Terra P1)', () => {
      // A cat entity that has BOTH roster AND proposal provenance should survive.
      // The presence of any non-roster/non-system source means it carries extra
      // information beyond what the roster provides.
      seedEntities(db, [
        {
          entityId: 'cat:hybrid-guide',
          type: 'cat',
          canonicalName: 'hybrid-guide',
          aliases: ['hybrid-guide'],
          provenance: [
            { source: 'F032 roster', anchor: 'cat-template.json' },
            { source: 'proposal', anchor: 'ep-12' },
          ],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: NOW,
        },
      ]);

      const results = detector.detect('hybrid-guide 在线');
      assert.equal(results.length, 1, 'cat with mixed provenance (roster+proposal) should NOT be filtered');
      assert.equal(results[0].entityId, 'cat:hybrid-guide');
    });
  });
});
