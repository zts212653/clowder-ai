import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSelfFacet } from '../../dist/domains/home-state/self-facet.js';
import { selfFacetSourcesFromRuntime } from '../../dist/domains/home-state/self-facet-sources.js';

/**
 * F300 -- one installation, one coordinate.
 *
 * The launcher `cd`s into `packages/api` before starting the API
 * (`start-dev.sh:990-992`), so `process.cwd()` is not the checkout root. A facet
 * that read the root for `installation.projectRoot` and the cwd for
 * `runtime.worktree` handed the reader two different answers to the same
 * question -- and the self-host guard compares both against stop targets.
 */

const CHECKOUT_ROOT = '/home/user/cat-cafe-f300';

function sources(env) {
  return selfFacetSourcesFromRuntime({
    env,
    apiPort: 3002,
    invocation: { catId: 'opus5' },
    gitHead: () => 'abc1234',
    now: () => 1,
  });
}

describe('selfFacetSourcesFromRuntime: installation and runtime name one root', () => {
  it('reports the resolved runtime root as the worktree, not the process cwd', async () => {
    const facet = await buildSelfFacet(sources({ CAT_CAFE_RUNTIME_ROOT: CHECKOUT_ROOT }));
    assert.equal(facet.installation.projectRoot, CHECKOUT_ROOT);
    assert.equal(facet.runtime.worktree, CHECKOUT_ROOT);
    assert.notEqual(facet.runtime.worktree, process.cwd());
  });

  it('keeps both coordinates on the same fallback when the root is not configured', async () => {
    const facet = await buildSelfFacet(sources({}));
    assert.equal(facet.runtime.worktree, facet.installation.projectRoot);
  });
});
