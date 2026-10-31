import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F245 Phase C PR1b — friction sourceRefs validation unit tests (L2).
 *
 * Covers the three new validation.ts surfaces:
 *   - isFrictionSourceRefs discriminator
 *   - inferSourceRefsKind → 'friction-rollup-snapshot' (and that the friction
 *     guard runs BEFORE the a2a backward-compat default — a2a returns true for
 *     undefined/missing kind, so friction must be checked first)
 *   - validateFrictionRollupSelector accept + reject paths
 *
 * TDD: imports from dist; written RED before validation.ts is edited.
 */

const IMPORT_PATH_VALIDATION = '../../dist/infrastructure/harness-eval/publish-verdict/validation.js';

function stubFrictionRefs(overrides = {}) {
  return {
    kind: 'friction-rollup-snapshot',
    windowStartMs: 1_780_000_000_000,
    windowEndMs: 1_780_600_000_000,
    ...overrides,
  };
}

describe('isFrictionSourceRefs', () => {
  it('returns true for friction-rollup-snapshot kind', async () => {
    const { isFrictionSourceRefs } = await import(IMPORT_PATH_VALIDATION);
    assert.equal(isFrictionSourceRefs(stubFrictionRefs()), true);
  });

  it('returns false for other kinds and undefined', async () => {
    const { isFrictionSourceRefs } = await import(IMPORT_PATH_VALIDATION);
    assert.equal(isFrictionSourceRefs({ kind: 'a2a-snapshot-attribution' }), false);
    assert.equal(isFrictionSourceRefs({ kind: 'memory-recall-snapshot' }), false);
    assert.equal(isFrictionSourceRefs({ kind: 'task-outcome-snapshot' }), false);
    assert.equal(isFrictionSourceRefs(undefined), false);
    assert.equal(isFrictionSourceRefs({}), false);
  });
});

describe('inferSourceRefsKind (friction)', () => {
  it('returns friction-rollup-snapshot for friction refs', async () => {
    const { inferSourceRefsKind } = await import(IMPORT_PATH_VALIDATION);
    assert.equal(inferSourceRefsKind(stubFrictionRefs()), 'friction-rollup-snapshot');
  });

  it('does NOT misclassify friction refs as a2a (guard runs before a2a default)', async () => {
    const { inferSourceRefsKind } = await import(IMPORT_PATH_VALIDATION);
    // a2a default returns true for missing/undefined kind; friction must be
    // resolved by its own discriminator first.
    assert.notEqual(inferSourceRefsKind(stubFrictionRefs()), 'a2a-snapshot-attribution');
  });

  it('still returns a2a for undefined (backward-compat default preserved)', async () => {
    const { inferSourceRefsKind } = await import(IMPORT_PATH_VALIDATION);
    assert.equal(inferSourceRefsKind(undefined), 'a2a-snapshot-attribution');
  });
});

describe('validateFrictionRollupSelector', () => {
  it('accepts a valid selector (no optional fields)', async () => {
    const { validateFrictionRollupSelector } = await import(IMPORT_PATH_VALIDATION);
    assert.equal(validateFrictionRollupSelector(stubFrictionRefs()), null);
  });

  it('accepts a valid selector with optional topN + tokenCap', async () => {
    const { validateFrictionRollupSelector } = await import(IMPORT_PATH_VALIDATION);
    assert.equal(validateFrictionRollupSelector(stubFrictionRefs({ topN: 5, tokenCap: 2000 })), null);
  });

  it('rejects wrong kind', async () => {
    const { validateFrictionRollupSelector } = await import(IMPORT_PATH_VALIDATION);
    const err = validateFrictionRollupSelector({ ...stubFrictionRefs(), kind: 'a2a-snapshot-attribution' });
    assert.ok(err);
    assert.match(err, /friction-rollup-snapshot/);
  });

  it('rejects non-finite windowStartMs', async () => {
    const { validateFrictionRollupSelector } = await import(IMPORT_PATH_VALIDATION);
    assert.ok(validateFrictionRollupSelector(stubFrictionRefs({ windowStartMs: Number.NaN })));
    assert.ok(validateFrictionRollupSelector(stubFrictionRefs({ windowStartMs: 'x' })));
  });

  it('rejects non-finite windowEndMs', async () => {
    const { validateFrictionRollupSelector } = await import(IMPORT_PATH_VALIDATION);
    assert.ok(validateFrictionRollupSelector(stubFrictionRefs({ windowEndMs: Number.POSITIVE_INFINITY })));
  });

  it('rejects windowEndMs <= windowStartMs', async () => {
    const { validateFrictionRollupSelector } = await import(IMPORT_PATH_VALIDATION);
    const err = validateFrictionRollupSelector(stubFrictionRefs({ windowStartMs: 100, windowEndMs: 100 }));
    assert.ok(err);
    assert.match(err, /windowEndMs/);
  });

  it('rejects non-positive-integer topN', async () => {
    const { validateFrictionRollupSelector } = await import(IMPORT_PATH_VALIDATION);
    assert.ok(validateFrictionRollupSelector(stubFrictionRefs({ topN: 0 })));
    assert.ok(validateFrictionRollupSelector(stubFrictionRefs({ topN: -3 })));
    assert.ok(validateFrictionRollupSelector(stubFrictionRefs({ topN: 2.5 })));
  });

  it('rejects non-positive-integer tokenCap', async () => {
    const { validateFrictionRollupSelector } = await import(IMPORT_PATH_VALIDATION);
    assert.ok(validateFrictionRollupSelector(stubFrictionRefs({ tokenCap: 0 })));
    assert.ok(validateFrictionRollupSelector(stubFrictionRefs({ tokenCap: 12.3 })));
  });
});
