/**
 * F237 Phase 2-B: Resolver registry tests
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('ResolverRegistry', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/index.js')} */
  let registry;

  /** @type {readonly string[]} */
  let canonicalUnitIds;

  it('load module', async () => {
    registry = await import('../dist/domains/prompt-hooks/resolvers/index.js');
    ({ CANONICAL_UNIT_IDS: canonicalUnitIds } = await import(
      '../dist/infrastructure/harness-eval/unit-evaluation-manifest.js'
    ));
  });

  it('registers exactly the canonical baseline unit ids', () => {
    // Explicit id sets, not a count: `=== 46` would stay green while one hook lost its
    // resolver and another gained one. This also keeps the resolver registry and the F257
    // unit census from drifting apart. D22 is governance-authored and has no resolver.
    assert.deepEqual(
      [...registry.getRegisteredResolverIds()].sort(),
      [...canonicalUnitIds].sort(),
      `resolver id set drifted (registered=${registry.RESOLVER_COUNT}, canonical=${canonicalUnitIds.length})`,
    );
    assert.equal(registry.RESOLVER_COUNT, registry.getRegisteredResolverIds().length);
  });

  it('covers all L-series (L1-L7)', () => {
    for (let i = 1; i <= 7; i++) {
      assert.ok(registry.getResolver(`L${i}`), `Missing resolver for L${i}`);
    }
  });

  it('covers every canonical S-series id', () => {
    for (const id of canonicalUnitIds.filter((unitId) => unitId.startsWith('S'))) {
      assert.ok(registry.getResolver(id), `Missing resolver for ${id}`);
    }
  });

  it('covers all D-series (D1-D21)', () => {
    for (let i = 1; i <= 21; i++) {
      assert.ok(registry.getResolver(`D${i}`), `Missing resolver for D${i}`);
    }
  });

  it('covers B1, C1, R1, R2, N1', () => {
    for (const id of ['B1', 'C1', 'R1', 'R2', 'N1']) {
      assert.ok(registry.getResolver(id), `Missing resolver for ${id}`);
    }
  });

  it('returns undefined for unknown hook IDs', () => {
    assert.equal(registry.getResolver('Z99'), undefined);
    assert.equal(registry.getResolver('NONEXISTENT'), undefined);
  });

  it('all resolvers implement resolve()', () => {
    const ids = registry.getRegisteredResolverIds();
    assert.equal(ids.length, canonicalUnitIds.length);
    for (const id of ids) {
      const resolver = registry.getResolver(id);
      assert.equal(typeof resolver.resolve, 'function', `${id} resolver missing resolve()`);
    }
  });
});
