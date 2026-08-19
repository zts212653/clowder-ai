/**
 * F260 Phase B: EntityNudgeBuilder — turns DetectedEntity[] into nudge payloads.
 *
 * The nudge is typed metadata that:
 *   - AC-B2: Contains anchor + date + type (provenance), zero content paraphrase
 *   - AC-B5: Emits telemetry with entity_nudge_outcome
 *   - AC-B6: NOT stored in canonical message / evidence / digest
 *   - M5: Only anchor + metadata — never the entity's actual content
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

let EntityNudgeBuilder;

describe('EntityNudgeBuilder', () => {
  beforeEach(async () => {
    const mod = await import('../../dist/domains/memory/EntityNudgeBuilder.js');
    EntityNudgeBuilder = mod.EntityNudgeBuilder;
  });

  // ─── AC-B2: Nudge rendering ───

  describe('nudge rendering (AC-B2)', () => {
    it('produces nudge text with anchor and type — no content paraphrase (M5)', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          entityId: 'concept:未婚喵',
          matchedAlias: '未婚喵',
          type: 'concept',
          confidence: 1.0,
          sourceTable: 'entity_registry',
          provenance: [{ source: 'manual', anchor: 'thread-diary', date: '2026-06-01' }],
          stance: 'endorsed',
        },
      ]);

      assert.equal(nudges.length, 1);
      const n = nudges[0];

      // Must contain anchor reference
      assert.ok(n.text.includes('concept:未婚喵') || n.text.includes('未婚喵'), 'text should reference entity');

      // M5: must NOT contain any content/description/summary of the entity
      // (we verify by checking it doesn't have "means" / "is about" / "describes" etc.)
      assert.ok(!n.text.includes('定义'), 'must not paraphrase content');
      assert.ok(!n.text.includes('描述'), 'must not paraphrase content');

      // Must have provenance metadata
      assert.ok(n.provenance, 'must include provenance');
      assert.equal(n.kind, 'entity_nudge', 'kind must be entity_nudge');
    });

    it('renders doc_aliases with docAnchor', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          docAnchor: 'cat-pack-manifesto.md',
          matchedAlias: '猫猫共犯伙伴-记忆篇',
          type: 'doc',
          confidence: 0.5,
          sourceTable: 'doc_aliases',
        },
      ]);

      assert.equal(nudges.length, 1);
      assert.ok(nudges[0].text.includes('cat-pack-manifesto.md'), 'should reference doc anchor');
    });

    it('returns empty for empty input', () => {
      const builder = new EntityNudgeBuilder();
      assert.deepEqual(builder.build([]), []);
    });

    it('includes canonicalName in nudge text when it differs from matchedAlias (operator 钓猫 bug)', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          entityId: 'concept:未婚喵',
          matchedAlias: '未婚喵',
          canonicalName: '未婚喵（→ 宪宪/fable-5）',
          type: 'concept',
          confidence: 1.0,
          sourceTable: 'entity_registry',
          provenance: [{ source: 'cvo-propose', anchor: 'ep-2' }],
          stance: 'endorsed',
        },
      ]);

      assert.equal(nudges.length, 1);
      const text = nudges[0].text;
      // Must surface the canonicalName so the cat can see WHO/WHAT it refers to
      assert.ok(text.includes('未婚喵（→ 宪宪/fable-5）'), `nudge text should include canonicalName; got: ${text}`);
    });

    it('omits canonicalName suffix when it matches matchedAlias (no redundancy)', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          entityId: 'cat:codex-sol',
          matchedAlias: '小太阳',
          canonicalName: '小太阳',
          type: 'cat',
          confidence: 1.0,
          sourceTable: 'entity_registry',
          provenance: [{ source: 'manual' }],
        },
      ]);

      // canonicalName === matchedAlias → should NOT duplicate
      const text = nudges[0].text;
      const count = (text.match(/小太阳/g) || []).length;
      assert.ok(count <= 2, `matchedAlias should not appear more than twice; got ${count} in: ${text}`);
    });
  });

  // ─── AC-B6: Storage boundary ───

  describe('storage boundary (AC-B6)', () => {
    it('nudge payload has storable=false flag', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          entityId: 'concept:未婚喵',
          matchedAlias: '未婚喵',
          type: 'concept',
          confidence: 1.0,
          sourceTable: 'entity_registry',
          provenance: [{ source: 'manual' }],
        },
      ]);

      assert.equal(nudges[0].storable, false, 'nudge must be marked non-storable');
    });

    it('nudge payload has indexable=false flag', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          entityId: 'concept:未婚喵',
          matchedAlias: '未婚喵',
          type: 'concept',
          confidence: 1.0,
          sourceTable: 'entity_registry',
          provenance: [{ source: 'manual' }],
        },
      ]);

      assert.equal(nudges[0].indexable, false, 'nudge must be marked non-indexable');
    });
  });

  // ─── AC-B5: Telemetry shape ───

  describe('telemetry payload (AC-B5)', () => {
    it('produces telemetry event with required fields', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          entityId: 'concept:未婚喵',
          matchedAlias: '未婚喵',
          type: 'concept',
          confidence: 1.0,
          sourceTable: 'entity_registry',
          provenance: [{ source: 'manual' }],
          stance: 'endorsed',
        },
      ]);

      const tel = nudges[0].telemetry;
      assert.ok(tel, 'must include telemetry payload');
      assert.equal(tel.entityId, 'concept:未婚喵');
      assert.equal(tel.sourceFamily, 'entity_registry');
      assert.equal(tel.aliasClass, 'concept');
      assert.equal(typeof tel.confidence, 'number');
    });

    it('doc_aliases telemetry uses sourceFamily=doc_aliases', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          docAnchor: 'some-doc.md',
          matchedAlias: 'some title',
          type: 'doc',
          confidence: 0.5,
          sourceTable: 'doc_aliases',
        },
      ]);

      assert.equal(nudges[0].telemetry.sourceFamily, 'doc_aliases');
      assert.equal(nudges[0].telemetry.aliasClass, 'doc');
    });
  });

  // ─── Nudge result shape ───

  describe('result shape', () => {
    it('NudgePayload has all required fields', () => {
      const builder = new EntityNudgeBuilder();
      const nudges = builder.build([
        {
          entityId: 'concept:未婚喵',
          matchedAlias: '未婚喵',
          type: 'concept',
          confidence: 1.0,
          sourceTable: 'entity_registry',
          provenance: [{ source: 'manual' }],
          stance: 'endorsed',
        },
      ]);

      const n = nudges[0];
      assert.equal(typeof n.text, 'string');
      assert.equal(typeof n.kind, 'string');
      assert.equal(typeof n.storable, 'boolean');
      assert.equal(typeof n.indexable, 'boolean');
      assert.ok(n.telemetry != null);
      // entityId or docAnchor must be present
      assert.ok(n.entityId || n.docAnchor, 'must have entity reference');
    });
  });
});
