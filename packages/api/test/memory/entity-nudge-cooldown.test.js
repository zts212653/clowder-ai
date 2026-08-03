/**
 * F260 Phase B AC-B4: Noise control — cooldown manager.
 *
 * Rules:
 *   - Max 3 nudges per message (already handled by InputEntityDetector.maxResults)
 *   - 24h cooldown per entity per thread: same entity in same thread = suppress
 *   - Context dedup: already in conversation context = suppress (handled by detector)
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

let EntityNudgeCooldown;

describe('EntityNudgeCooldown (AC-B4)', () => {
  beforeEach(async () => {
    const mod = await import('../../dist/domains/memory/EntityNudgeCooldown.js');
    EntityNudgeCooldown = mod.EntityNudgeCooldown;
  });

  it('allows first nudge for an entity in a thread', () => {
    const cooldown = new EntityNudgeCooldown();
    const allowed = cooldown.isAllowed('concept:未婚喵', 'thread-1', Date.now());
    assert.equal(allowed, true);
  });

  it('suppresses same entity in same thread within 24h', () => {
    const cooldown = new EntityNudgeCooldown();
    const now = Date.now();
    cooldown.record('concept:未婚喵', 'thread-1', now);
    const allowed = cooldown.isAllowed('concept:未婚喵', 'thread-1', now + 1000);
    assert.equal(allowed, false, 'should suppress within 24h');
  });

  it('allows same entity in different thread', () => {
    const cooldown = new EntityNudgeCooldown();
    const now = Date.now();
    cooldown.record('concept:未婚喵', 'thread-1', now);
    const allowed = cooldown.isAllowed('concept:未婚喵', 'thread-2', now + 1000);
    assert.equal(allowed, true, 'different thread should not be suppressed');
  });

  it('allows same entity after 24h cooldown expires', () => {
    const cooldown = new EntityNudgeCooldown();
    const now = Date.now();
    cooldown.record('concept:未婚喵', 'thread-1', now);

    const after24h = now + 24 * 60 * 60 * 1000 + 1;
    const allowed = cooldown.isAllowed('concept:未婚喵', 'thread-1', after24h);
    assert.equal(allowed, true, 'should allow after 24h expiry');
  });

  it('allows different entity in same thread', () => {
    const cooldown = new EntityNudgeCooldown();
    const now = Date.now();
    cooldown.record('concept:未婚喵', 'thread-1', now);
    const allowed = cooldown.isAllowed('concept:新梗', 'thread-1', now + 1000);
    assert.equal(allowed, true, 'different entity should not be suppressed');
  });

  it('filterNudges removes cooldown-suppressed entities', () => {
    const cooldown = new EntityNudgeCooldown();
    const now = Date.now();
    cooldown.record('concept:未婚喵', 'thread-1', now);

    const nudges = [
      { entityId: 'concept:未婚喵', kind: 'entity_nudge' },
      { entityId: 'concept:新梗', kind: 'entity_nudge' },
      { docAnchor: 'some-doc.md', kind: 'entity_nudge' },
    ];

    const filtered = cooldown.filterNudges(nudges, 'thread-1', now + 1000);
    assert.equal(filtered.length, 2, 'should remove suppressed entity');
    assert.ok(!filtered.some((n) => n.entityId === 'concept:未婚喵'));
    assert.ok(filtered.some((n) => n.entityId === 'concept:新梗'));
    assert.ok(filtered.some((n) => n.docAnchor === 'some-doc.md'));
  });

  it('recordAll records all entities from nudge list', () => {
    const cooldown = new EntityNudgeCooldown();
    const now = Date.now();

    const nudges = [
      { entityId: 'concept:未婚喵', kind: 'entity_nudge' },
      { docAnchor: 'some-doc.md', kind: 'entity_nudge' },
    ];

    cooldown.recordAll(nudges, 'thread-1', now);

    assert.equal(cooldown.isAllowed('concept:未婚喵', 'thread-1', now + 1000), false);
    assert.equal(cooldown.isAllowed('some-doc.md', 'thread-1', now + 1000), false);
  });
});
