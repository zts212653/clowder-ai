import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorityToConfidence, pathToAuthority } from '../dist/domains/memory/f163-types.js';
import { INDEXING_VERSION } from '../dist/domains/memory/IndexBuilder.js';

describe('pathToAuthority', () => {
  it('maps lessons-learned to constitutional', () => {
    assert.equal(pathToAuthority('docs/lessons-learned.md'), 'constitutional');
  });

  it('maps shared-rules to constitutional', () => {
    assert.equal(pathToAuthority('docs/shared-rules.md'), 'constitutional');
    assert.equal(pathToAuthority('cat-cafe-skills/refs/shared-rules.md'), 'constitutional');
  });

  it('maps decisions/ to validated', () => {
    assert.equal(pathToAuthority('docs/decisions/009-skills-distribution.md'), 'validated');
  });

  it('maps features/ to validated', () => {
    assert.equal(pathToAuthority('docs/features/F163-memory-entropy-reduction.md'), 'validated');
  });

  it('maps SOP to constitutional', () => {
    assert.equal(pathToAuthority('docs/SOP.md'), 'constitutional');
  });

  it('maps discussions/ to candidate', () => {
    assert.equal(pathToAuthority('docs/discussions/2026-04-15-harness-engineering/README.md'), 'candidate');
  });

  it('maps plans/ to candidate', () => {
    assert.equal(pathToAuthority('docs/plans/2026-04-16-f163-phase-a.md'), 'candidate');
  });

  it('maps research/ to candidate', () => {
    assert.equal(pathToAuthority('docs/research/2026-04-16-f163/research-brief.md'), 'candidate');
  });

  it('defaults to observed for unknown paths', () => {
    assert.equal(pathToAuthority('random/file.md'), 'observed');
    assert.equal(pathToAuthority(''), 'observed');
  });

  it('handles source_path without docs/ prefix', () => {
    assert.equal(pathToAuthority('lessons-learned.md'), 'constitutional');
    assert.equal(pathToAuthority('decisions/009-foo.md'), 'validated');
    assert.equal(pathToAuthority('features/F042-info-arch.md'), 'validated');
  });

  it('handles anchor-format doc: prefix (P2 fix)', () => {
    assert.equal(pathToAuthority('doc:lessons-learned.md'), 'constitutional');
    assert.equal(pathToAuthority('doc:decisions/009-foo.md'), 'validated');
    assert.equal(pathToAuthority('doc:features/F163-memory-entropy-reduction.md'), 'validated');
    assert.equal(pathToAuthority('doc:discussions/2026-04-15-harness-engineering'), 'candidate');
    assert.equal(pathToAuthority('doc:SOP.md'), 'constitutional');
  });
});

describe('INDEXING_VERSION bump (P1 fix)', () => {
  it('should be 3 to force authority backfill on existing docs', () => {
    assert.equal(INDEXING_VERSION, 3, 'INDEXING_VERSION must be bumped to 3 so existing docs get authority backfilled');
  });
});

describe('authorityToConfidence', () => {
  it('maps constitutional to high', () => {
    assert.equal(authorityToConfidence('constitutional'), 'high');
  });

  it('maps validated to high', () => {
    assert.equal(authorityToConfidence('validated'), 'high');
  });

  it('maps candidate to mid', () => {
    assert.equal(authorityToConfidence('candidate'), 'mid');
  });

  it('maps observed to low', () => {
    assert.equal(authorityToConfidence('observed'), 'low');
  });

  it('defaults to mid for undefined', () => {
    assert.equal(authorityToConfidence(undefined), 'mid');
  });
});
