/**
 * F237 Phase 2-B: Resolver registry tests
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('ResolverRegistry', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/index.js')} */
  let registry;

  it('load module', async () => {
    registry = await import('../dist/domains/prompt-hooks/resolvers/index.js');
  });

  it('has exactly 46 resolvers registered', () => {
    assert.equal(registry.RESOLVER_COUNT, 46);
  });

  it('covers all L-series (L1-L7)', () => {
    for (let i = 1; i <= 7; i++) {
      assert.ok(registry.getResolver(`L${i}`), `Missing resolver for L${i}`);
    }
  });

  it('covers all S-series (S1-S13)', () => {
    for (let i = 1; i <= 13; i++) {
      assert.ok(registry.getResolver(`S${i}`), `Missing resolver for S${i}`);
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
    assert.equal(ids.length, 46);
    for (const id of ids) {
      const resolver = registry.getResolver(id);
      assert.equal(typeof resolver.resolve, 'function', `${id} resolver missing resolve()`);
    }
  });
});
