import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const loadFacet = () => import('../../dist/domains/home-state/self-facet.js');
const loadQuota = () => import('../../dist/domains/home-state/quota-facet.js');
const loadSources = () => import('../../dist/domains/home-state/self-facet-sources.js');

/**
 * F300 WP1.1 — the vision-guardian repairs.
 *
 * Three of the four are the same defect I spent WP1's review rounds removing
 * from the guard, and then shipped inside the facet anyway: a value that cannot
 * be established is folded into one that looks established. An empty string for
 * a revision, an empty array for leases, and a caller's own assertion standing
 * in for a resolved account.
 */

const baseDeps = () => ({
  now: () => 1_700_000_000_000,
  installation: () => ({ projectRoot: '/rt', deploymentId: 'runtime', sourceRef: 'daemon-state:/rt#runtime' }),
  runtimeStatus: () => ({
    worktree: '/rt',
    head: { revision: 'abc1234', source: 'running' },
    apiPid: 4242,
    apiPort: 3002,
    sourceRef: 'daemon-state:/rt#runtime',
  }),
  platform: () => ({ os: 'darwin', arch: 'arm64', hostNodeId: 'x', sourceRef: 'process:1#platform' }),
  invocation: { catId: 'opus5' },
});

describe('WP1.1 item 2: an unwired lease reader is not an empty lease set', () => {
  it('reports unknown when no lease resolver is wired', async () => {
    const { buildSelfFacet } = await loadFacet();
    const facet = await buildSelfFacet(baseDeps());
    assert.equal(facet.heldLeases, 'unknown');
  });

  it('reports the refs when the resolver really answers', async () => {
    const { buildSelfFacet } = await loadFacet();
    const facet = await buildSelfFacet({ ...baseDeps(), heldLeases: () => ['lease:a', 'lease:b'] });
    assert.deepEqual(facet.heldLeases, ['lease:a', 'lease:b']);
  });

  it('keeps a genuinely empty answer distinct from an unwired one', async () => {
    const { buildSelfFacet } = await loadFacet();
    const facet = await buildSelfFacet({ ...baseDeps(), heldLeases: () => [] });
    assert.deepEqual(facet.heldLeases, []);
  });
});

describe('WP1.1 item 1: a revision says which thing it is the revision of', () => {
  it('carries the running instance revision with its source', async () => {
    const { buildSelfFacet } = await loadFacet();
    const facet = await buildSelfFacet(baseDeps());
    assert.deepEqual(facet.runtime.head, { revision: 'abc1234', source: 'running' });
  });

  it('labels a checkout reading as proving only the checkout', async () => {
    const { buildSelfFacet } = await loadFacet();
    const deps = baseDeps();
    const facet = await buildSelfFacet({
      ...deps,
      runtimeStatus: () => ({ ...deps.runtimeStatus(), head: { revision: 'def5678', source: 'checkout' } }),
    });
    assert.equal(facet.runtime.head.source, 'checkout');
  });

  it('reports unknown rather than an empty string when no revision can be read', async () => {
    const { buildSelfFacet } = await loadFacet();
    const deps = baseDeps();
    const facet = await buildSelfFacet({
      ...deps,
      runtimeStatus: () => ({ ...deps.runtimeStatus(), head: 'unknown' }),
    });
    assert.equal(facet.runtime.head, 'unknown');
  });
});

/**
 * The block above proves the shape survives the facet. This one proves the
 * rule that produces it, which is where the repair actually lives: the tests
 * that only inject a finished `runtimeStatus` would still pass if the
 * running/checkout precedence were backwards.
 */
describe('WP1.1 item 1: which source wins, and when nothing does', () => {
  const sourceOptions = (overrides) => ({
    env: {},
    invocation: { catId: 'opus5' },
    gitHead: () => '',
    ...overrides,
  });

  it("prefers the running artifact's revision over the checkout", async () => {
    const { selfFacetSourcesFromRuntime } = await loadSources();
    const deps = selfFacetSourcesFromRuntime(
      sourceOptions({ runningRevision: () => 'running111', gitHead: () => 'checkout222' }),
    );
    assert.deepEqual((await deps.runtimeStatus()).head, { revision: 'running111', source: 'running' });
  });

  it('falls back to the checkout and says that is what it is', async () => {
    const { selfFacetSourcesFromRuntime } = await loadSources();
    const deps = selfFacetSourcesFromRuntime(
      sourceOptions({ runningRevision: () => undefined, gitHead: () => 'checkout222' }),
    );
    assert.deepEqual((await deps.runtimeStatus()).head, { revision: 'checkout222', source: 'checkout' });
  });

  it('treats the packaged-install empty string as unknown, not as a revision', async () => {
    const { selfFacetSourcesFromRuntime } = await loadSources();
    // `readGitHead` returns '' when there is no checkout to read. That is the
    // shape that used to travel all the way to the caller as a head value.
    const deps = selfFacetSourcesFromRuntime(sourceOptions({ gitHead: () => '' }));
    assert.equal((await deps.runtimeStatus()).head, 'unknown');
  });

  // Reviewed 2026-09-14 (codex-astra, #4545 R1): the route re-read the build
  // stamp per request, so building newer files on disk relabelled the process
  // still serving as running them.
  it('keeps the running revision fixed when a newer build is stamped on disk', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const Fastify = (await import('fastify')).default;
    const { homeStateRoutes } = await import('../../dist/routes/home-state.js');

    const root = mkdtempSync(join(tmpdir(), 'f300-running-stamp-'));
    const stamp = (revision) => {
      for (const relative of ['packages/api/dist', 'packages/web/.next']) {
        mkdirSync(join(root, relative), { recursive: true });
        writeFileSync(join(root, relative, '.build-commit'), revision);
      }
    };
    const saved = process.env.CAT_CAFE_RUNTIME_ROOT;
    stamp('a'.repeat(40));
    process.env.CAT_CAFE_RUNTIME_ROOT = root;
    const app = Fastify();
    try {
      await app.register(homeStateRoutes);
      const before = (await app.inject('/api/home-state/self')).json();
      assert.deepEqual(before.runtime.head, { revision: 'a'.repeat(40), source: 'running' });
      stamp('b'.repeat(40));
      const after = (await app.inject('/api/home-state/self')).json();
      assert.equal(after.runtime.apiPid, before.runtime.apiPid);
      assert.deepEqual(after.runtime.head, before.runtime.head);
    } finally {
      await app.close();
      if (saved === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the startup-captured revision it was handed, not a fresh read', async () => {
    const Fastify = (await import('fastify')).default;
    const { homeStateRoutes } = await import('../../dist/routes/home-state.js');
    for (const [captured, expected] of [
      ['c'.repeat(40), { revision: 'c'.repeat(40), source: 'running' }],
      [null, undefined],
    ]) {
      const app = Fastify();
      try {
        await app.register(homeStateRoutes, { runningRevision: captured });
        const head = (await app.inject('/api/home-state/self')).json().runtime.head;
        if (expected) assert.deepEqual(head, expected);
        // null = no valid stamp at startup: never "running"; checkout or unknown only.
        else assert.ok(head === 'unknown' || head.source === 'checkout', JSON.stringify(head));
      } finally {
        await app.close();
      }
    }
  });

  it('is unknown when no running-revision reader is wired at all', async () => {
    const { selfFacetSourcesFromRuntime } = await loadSources();
    const deps = selfFacetSourcesFromRuntime(sourceOptions({ gitHead: () => '   ' }));
    assert.equal((await deps.runtimeStatus()).head, 'unknown');
  });
});

/**
 * #4545 review R3. The first repair replaced a caller's hint with the cat's
 * registered client, and that was the same defect one step removed: `openai`
 * names a provider, not the account or pool this invocation actually bills.
 * No owner attributes a quota reading to an account today, so the only true
 * answer is unknown -- however exhausted some platform's pool happens to be.
 */
describe('WP1.1 item 3: quota is not attributed without an account-to-pool binding', () => {
  it('reports unknown for the self facet source', async () => {
    const { selfFacetSourcesFromRuntime } = await loadSources();
    const deps = selfFacetSourcesFromRuntime({
      env: {},
      invocation: { catId: 'codex-astra' },
      gitHead: () => '',
    });
    assert.equal(await deps.quota(), 'unknown');
  });

  it('no longer exports a client-to-pool attribution to reach for', async () => {
    const quota = await loadQuota();
    assert.equal(quota.platformForClient, undefined);
    assert.equal(quota.resolveQuotaPlatform, undefined);
    assert.equal(quota.quotaResolverForCat, undefined);
  });
});
