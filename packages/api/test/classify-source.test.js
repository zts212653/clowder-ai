/**
 * F102 Issue 5: classifySource should map all EvidenceKind values,
 * not just decisions/phases/discussions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { classifySource, mapKindToSourceType } = await import('../dist/routes/evidence-helpers.js');

describe('classifySource (F102 Issue 5)', () => {
  it('maps decisions path', () => {
    assert.equal(classifySource('docs/decisions/ADR-001.md'), 'decision');
  });

  it('maps phases path', () => {
    assert.equal(classifySource('docs/phases/phase-a.md'), 'phase');
  });

  it('maps features path', () => {
    assert.equal(classifySource('docs/features/F102.md'), 'feature');
  });

  it('maps lessons path', () => {
    assert.equal(classifySource('docs/lessons/redis-pitfall.md'), 'lesson');
  });

  it('maps research path', () => {
    assert.equal(classifySource('docs/research/ai-survey.md'), 'research');
  });

  it('falls back to commit for unknown paths', () => {
    assert.equal(classifySource('some/random/path.md'), 'commit');
  });
});

describe('mapKindToSourceType (F102 Issue 5)', () => {
  it('maps feature kind', () => {
    assert.equal(mapKindToSourceType('feature'), 'feature');
  });

  it('maps decision kind', () => {
    assert.equal(mapKindToSourceType('decision'), 'decision');
  });

  it('maps plan kind to phase', () => {
    assert.equal(mapKindToSourceType('plan'), 'phase');
  });

  it('maps lesson kind', () => {
    assert.equal(mapKindToSourceType('lesson'), 'lesson');
  });

  it('maps research kind', () => {
    assert.equal(mapKindToSourceType('research'), 'research');
  });

  it('maps session kind to discussion', () => {
    assert.equal(mapKindToSourceType('session'), 'discussion');
  });

  it('maps thread kind to discussion', () => {
    assert.equal(mapKindToSourceType('thread'), 'discussion');
  });

  it('maps discussion kind', () => {
    assert.equal(mapKindToSourceType('discussion'), 'discussion');
  });

  it('maps pack-knowledge kind to knowledge', () => {
    assert.equal(mapKindToSourceType('pack-knowledge'), 'knowledge');
  });
});
