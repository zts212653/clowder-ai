import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const load = () => import('../../dist/domains/home-state/self-facet.js');

/**
 * F300 Task 1.1 — HomeStateSelfFacet is a pure projection.
 *
 * Every field is either an injected owner fact plus its own freshness/sourceRef,
 * or a typed absent value. The builder never caches, never stores and never
 * fabricates a fact it was not given (spec AC-O3, KD-12/14).
 */
describe('buildSelfFacet', () => {
  const baseDeps = () => ({
    now: () => 1_700_000_000_000,
    installation: () => ({
      projectRoot: '/rt',
      deploymentId: 'runtime',
      sourceRef: 'daemon-state:/rt#runtime',
    }),
    runtimeStatus: () => ({
      worktree: '/rt',
      head: 'abc',
      apiPid: 4242,
      apiPort: 3002,
      sourceRef: 'daemon-state:/rt#runtime',
    }),
    invocation: { threadId: 't1', invocationId: 'i1', catId: 'fable-5' },
    quota: () => null,
  });

  it('builds a self facet from injected sources with refs only', async () => {
    const { buildSelfFacet } = await load();
    const facet = await buildSelfFacet(baseDeps());

    assert.equal(facet.v, 1);
    assert.equal(facet.hostDependencies.find((d) => d.kind === 'api')?.pid, 4242);
    assert.equal(facet.quota, 'unknown');
    assert.ok(facet.runtime.observedAt > 0 && facet.runtime.sourceRef);
  });

  it('grounds installation, runtime, platform and coordinates as exact refs', async () => {
    const { buildSelfFacet } = await load();
    const facet = await buildSelfFacet(baseDeps());

    assert.equal(facet.installation.projectRoot, '/rt');
    assert.equal(facet.installation.deploymentId, 'runtime');
    assert.equal(facet.runtime.head, 'abc');
    assert.equal(facet.platform.os, process.platform);
    assert.equal(facet.platform.arch, process.arch);
    assert.ok(facet.platform.hostNodeId.length > 0);
    assert.deepEqual(facet.coordinates, { threadId: 't1', invocationId: 'i1', catId: 'fable-5' });
  });

  it('stamps every observed facet with its own observedAt and sourceRef', async () => {
    const { buildSelfFacet } = await load();
    const facet = await buildSelfFacet(baseDeps());

    for (const key of ['installation', 'runtime', 'platform']) {
      assert.equal(facet[key].observedAt, 1_700_000_000_000, `${key} observedAt`);
      assert.ok(facet[key].sourceRef, `${key} sourceRef`);
    }
  });

  it('lists the api host dependency the cat is running inside, with an identity ref', async () => {
    const { buildSelfFacet } = await load();
    const facet = await buildSelfFacet(baseDeps());

    const api = facet.hostDependencies.find((d) => d.kind === 'api');
    assert.equal(api.port, 3002);
    assert.equal(api.identityRef, 'daemon-state:/rt#runtime');
  });

  it('omits a host dependency it has no evidence for instead of inventing one', async () => {
    const { buildSelfFacet } = await load();
    const deps = baseDeps();
    deps.runtimeStatus = () => ({ worktree: '/rt', head: 'abc', sourceRef: 'git:/rt' });
    const facet = await buildSelfFacet(deps);

    assert.equal(
      facet.hostDependencies.find((d) => d.kind === 'api'),
      undefined,
    );
  });

  it('reports an exhausted quota pool as a typed owner fact (C-quota)', async () => {
    const { buildSelfFacet } = await load();
    const deps = baseDeps();
    deps.quota = () => ({ status: 'exhausted', poolRef: 'quota-pool:anthropic-weekly', sourceRef: 'f051:pool/1' });
    const facet = await buildSelfFacet(deps);

    assert.equal(facet.quota.status, 'exhausted');
    assert.equal(facet.quota.poolRef, 'quota-pool:anthropic-weekly');
    assert.ok(facet.quota.observedAt > 0 && facet.quota.sourceRef);
  });

  it('distinguishes an unreachable quota owner from an unknown one', async () => {
    const { buildSelfFacet } = await load();
    const deps = baseDeps();
    deps.quota = () => {
      throw new Error('provider account resolver down');
    };

    assert.equal((await buildSelfFacet(deps)).quota, 'owner_unreachable');
  });

  // spec §3: 可缓存项过期后只能是 unknown（不得降级为 stale-but-usable，也不得当成仍然 ok）
  it('treats an expired quota observation as unknown rather than still-ok', async () => {
    const { buildSelfFacet } = await load();
    const deps = baseDeps();
    deps.quota = () => ({
      status: 'ok',
      poolRef: 'quota-pool:anthropic-weekly',
      sourceRef: 'f051:pool/1',
      expiresAt: 1_699_999_999_999,
    });

    assert.equal((await buildSelfFacet(deps)).quota, 'unknown');
  });

  it('carries held leases as refs only', async () => {
    const { buildSelfFacet } = await load();
    const deps = baseDeps();
    deps.heldLeases = () => ['lease:52752674'];

    assert.deepEqual((await buildSelfFacet(deps)).heldLeases, ['lease:52752674']);
  });

  it('does not memoise: a second build re-reads its sources', async () => {
    const { buildSelfFacet } = await load();
    const deps = baseDeps();
    let reads = 0;
    deps.runtimeStatus = () => {
      reads += 1;
      return { worktree: '/rt', head: `head-${reads}`, sourceRef: 'git:/rt' };
    };

    assert.equal((await buildSelfFacet(deps)).runtime.head, 'head-1');
    assert.equal((await buildSelfFacet(deps)).runtime.head, 'head-2');
  });
});
