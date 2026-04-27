/**
 * F163 Types: flag snapshot + variant_id computation
 * Tests: freezeFlags reads env, computeVariantId is deterministic + stable
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySalienceRerank, computeVariantId, freezeFlags, salience } from '../../dist/domains/memory/f163-types.js';

describe('F163 types', () => {
  it('freezeFlags returns all 7 flags with default off', () => {
    // Clear any F163 env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const flags = freezeFlags();
    assert.equal(flags.authorityBoost, 'off');
    assert.equal(flags.alwaysOnInjection, 'off');
    assert.equal(flags.retrievalRerank, 'off');
    assert.equal(flags.compression, 'off');
    assert.equal(flags.promotionGate, 'off');
    assert.equal(flags.contradictionDetection, 'off');
    assert.equal(flags.reviewQueue, 'off');
  });

  it('freezeFlags reads env vars', () => {
    process.env.F163_AUTHORITY_BOOST = 'shadow';
    process.env.F163_ALWAYS_ON_INJECTION = 'on';
    try {
      const flags = freezeFlags();
      assert.equal(flags.authorityBoost, 'shadow');
      assert.equal(flags.alwaysOnInjection, 'on');
      assert.equal(flags.retrievalRerank, 'off'); // not set
    } finally {
      delete process.env.F163_AUTHORITY_BOOST;
      delete process.env.F163_ALWAYS_ON_INJECTION;
    }
  });

  it('freezeFlags returns frozen object', () => {
    const flags = freezeFlags();
    assert.throws(() => {
      // @ts-expect-error testing freeze
      flags.authorityBoost = 'on';
    }, TypeError);
  });

  it('computeVariantId is deterministic', () => {
    const flags = freezeFlags();
    const v1 = computeVariantId(flags);
    const v2 = computeVariantId(flags);
    assert.equal(v1, v2);
  });

  it('computeVariantId is 12 chars hex', () => {
    const flags = freezeFlags();
    const vid = computeVariantId(flags);
    assert.equal(vid.length, 12);
    assert.match(vid, /^[0-9a-f]{12}$/);
  });

  it('computeVariantId changes when flags change', () => {
    const flags1 = freezeFlags();
    const v1 = computeVariantId(flags1);

    process.env.F163_AUTHORITY_BOOST = 'on';
    try {
      const flags2 = freezeFlags();
      const v2 = computeVariantId(flags2);
      assert.notEqual(v1, v2);
    } finally {
      delete process.env.F163_AUTHORITY_BOOST;
    }
  });
});

describe('salience()', () => {
  const ctx = {
    activeFeatureIds: ['F163'],
    truthSourceRef: 'docs/features/F163-memory-entropy-reduction.md',
    recentArtifactRefs: ['docs/decisions/ADR-009.md'],
  };

  it('returns 1.0 for always_on docs (AC-F2: criticality=high exempt)', () => {
    const doc = { anchor: 'docs/SOP.md', activation: 'always_on', authority: 'constitutional' };
    assert.equal(salience(doc, ctx), 1.0);
  });

  it('returns 1.0 when no task context provided (graceful no-op)', () => {
    const doc = { anchor: 'docs/features/F088-chat-gateway.md', authority: 'validated' };
    const emptyCtx = { activeFeatureIds: [], truthSourceRef: null, recentArtifactRefs: [] };
    assert.equal(salience(doc, emptyCtx), 1.0);
  });

  it('treats empty-string truthSourceRef as no context (cloud P2)', () => {
    const doc = { anchor: 'F088', authority: 'validated', keywords: ['F088'] };
    const blankCtx = { activeFeatureIds: [], truthSourceRef: '', recentArtifactRefs: [] };
    assert.equal(salience(doc, blankCtx), 1.0);
  });

  it('returns lower score for doc unrelated to active task', () => {
    const doc = { anchor: 'docs/features/F088-chat-gateway.md', authority: 'validated', keywords: ['F088', 'chat'] };
    const score = salience(doc, ctx);
    assert.ok(score < 0.5, `expected < 0.5, got ${score}`);
  });

  it('returns higher score for doc matching active feature ID via anchor', () => {
    const doc = {
      anchor: 'docs/features/F163-memory-entropy-reduction.md',
      authority: 'validated',
      keywords: ['F163'],
    };
    const score = salience(doc, ctx);
    assert.ok(score >= 0.6, `expected >= 0.6, got ${score}`);
  });

  it('matches feature ID in keywords when anchor has no ID', () => {
    const doc = { anchor: 'docs/discussions/memory-rerank.md', authority: 'candidate', keywords: ['F163', 'rerank'] };
    const score = salience(doc, ctx);
    assert.ok(score >= 0.6, `expected >= 0.6 via keyword match, got ${score}`);
  });

  it('boosts doc matching truthSourceRef', () => {
    const doc = {
      anchor: 'docs/features/F163-memory-entropy-reduction.md',
      authority: 'validated',
      keywords: ['F163'],
    };
    const score = salience(doc, ctx);
    assert.ok(score >= 0.9, `expected >= 0.9 (feature + truth source), got ${score}`);
  });

  it('boosts doc matching recent artifact', () => {
    const doc = { anchor: 'docs/decisions/ADR-009.md', authority: 'validated', keywords: ['ADR-009'] };
    const score = salience(doc, ctx);
    assert.ok(score > 0.3, `expected > 0.3, got ${score}`);
  });

  it('caps at 1.0 even with all signals matching', () => {
    const doc = {
      anchor: 'docs/features/F163-memory-entropy-reduction.md',
      authority: 'constitutional',
      keywords: ['F163'],
    };
    const fullCtx = {
      activeFeatureIds: ['F163'],
      truthSourceRef: 'docs/features/F163-memory-entropy-reduction.md',
      recentArtifactRefs: ['F163'],
    };
    const score = salience(doc, fullCtx);
    assert.ok(score <= 1.0, `expected <= 1.0, got ${score}`);
  });

  it('same doc gets different salience under different context (AC-F4)', () => {
    const doc = { anchor: 'docs/features/F088-chat-gateway.md', authority: 'validated', keywords: ['F088'] };
    const ctxA = { activeFeatureIds: ['F088'], truthSourceRef: null, recentArtifactRefs: [] };
    const ctxB = { activeFeatureIds: ['F163'], truthSourceRef: null, recentArtifactRefs: [] };
    const scoreA = salience(doc, ctxA);
    const scoreB = salience(doc, ctxB);
    assert.ok(scoreA > scoreB, `expected scoreA(${scoreA}) > scoreB(${scoreB})`);
  });

  it('authority is weak prior — on-topic observed beats off-topic validated', () => {
    const onTopic = { anchor: 'docs/research/F163-salience.md', authority: 'observed', keywords: ['F163'] };
    const offTopic = { anchor: 'docs/features/F088-chat-gateway.md', authority: 'validated', keywords: ['F088'] };
    const scoreOn = salience(onTopic, ctx);
    const scoreOff = salience(offTopic, ctx);
    assert.ok(scoreOn > scoreOff, `on-topic observed(${scoreOn}) should beat off-topic validated(${scoreOff})`);
  });

  // P2-1 RED: unrelated doc with observed authority must score < 0.3 (AC-F3 threshold)
  it('unrelated observed doc scores below 0.3 (AC-F3 threshold reachable)', () => {
    const doc = { anchor: 'F088', authority: 'observed', keywords: ['F088'] };
    const score = salience(doc, ctx);
    assert.ok(score < 0.3, `expected < 0.3 for unrelated observed, got ${score}`);
  });

  // P1-3 RED: production anchors are short IDs, truthSourceRef may be a path
  it('matches truthSourceRef when anchor is short ID and ref is path (P1-3)', () => {
    const doc = { anchor: 'F163', authority: 'observed' };
    const pathCtx = {
      activeFeatureIds: [],
      truthSourceRef: 'docs/features/F163-memory-entropy-reduction.md',
      recentArtifactRefs: [],
    };
    const score = salience(doc, pathCtx);
    assert.ok(score >= 0.4, `expected truthSource boost >= 0.4, got ${score}`);
  });

  // P1-3 RED: production anchors are short IDs, recentArtifactRefs may be paths
  it('matches recentArtifactRef when anchor is short ID and ref is path (P1-3)', () => {
    const doc = { anchor: 'ADR-009', authority: 'observed' };
    const pathCtx = {
      activeFeatureIds: [],
      truthSourceRef: null,
      recentArtifactRefs: ['docs/decisions/ADR-009.md'],
    };
    const score = salience(doc, pathCtx);
    assert.ok(score >= 0.35, `expected artifact boost >= 0.35, got ${score}`);
  });
});

describe('applySalienceRerank()', () => {
  const ctx = {
    activeFeatureIds: ['F163'],
    truthSourceRef: null,
    recentArtifactRefs: [],
  };

  it('preserves order when no task context (all scores 1.0)', () => {
    const items = [
      { anchor: 'docs/features/F088.md', authority: 'validated' },
      { anchor: 'docs/features/F042.md', authority: 'validated' },
    ];
    const emptyCtx = { activeFeatureIds: [], truthSourceRef: null, recentArtifactRefs: [] };
    const result = applySalienceRerank(items, emptyCtx);
    assert.deepEqual(
      result.items.map((i) => i.anchor),
      ['docs/features/F088.md', 'docs/features/F042.md'],
    );
    assert.deepEqual(result.scores, [1.0, 1.0]);
  });

  it('moves matching doc ahead of non-matching', () => {
    const items = [
      { anchor: 'docs/features/F088-chat-gateway.md', authority: 'validated', keywords: ['F088'] },
      { anchor: 'docs/features/F163-memory-entropy.md', authority: 'validated', keywords: ['F163'] },
    ];
    const result = applySalienceRerank(items, ctx);
    assert.equal(result.items[0].anchor, 'docs/features/F163-memory-entropy.md');
  });

  it('always_on docs stay at top regardless of context', () => {
    const items = [
      { anchor: 'docs/SOP.md', activation: 'always_on', authority: 'constitutional' },
      { anchor: 'docs/features/F088.md', authority: 'validated', keywords: ['F088'] },
    ];
    const result = applySalienceRerank(items, ctx);
    assert.equal(result.items[0].anchor, 'docs/SOP.md');
    assert.equal(result.scores[0], 1.0);
  });

  it('stable sort: equal scores preserve original order', () => {
    const items = [
      { anchor: 'docs/a.md', authority: 'observed' },
      { anchor: 'docs/b.md', authority: 'observed' },
    ];
    const result = applySalienceRerank(items, ctx);
    assert.deepEqual(
      result.items.map((i) => i.anchor),
      ['docs/a.md', 'docs/b.md'],
    );
  });

  it('returns scores array matching reranked item order', () => {
    const items = [
      { anchor: 'docs/features/F088.md', authority: 'validated', keywords: ['F088'] },
      { anchor: 'docs/features/F163.md', authority: 'validated', keywords: ['F163'] },
    ];
    const result = applySalienceRerank(items, ctx);
    assert.equal(result.scores.length, 2);
    assert.ok(result.scores[0] >= result.scores[1]);
  });
});
