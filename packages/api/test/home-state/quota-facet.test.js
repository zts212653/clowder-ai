import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const load = () => import('../../dist/domains/home-state/quota-facet.js');

/**
 * F300 Task 1.5 -- C-quota.
 *
 * On 2026-09-07 a cat ran out of budget and kept working for two hours without
 * noticing. The facts were already there (F051 quota summary); nothing carried
 * them to the cat. This projection is that carry, and it must never soften a
 * missing or failed reading into "still fine".
 */

function platform(overrides = {}) {
  return {
    id: 'claude',
    label: 'Claude',
    displayPercent: 10,
    displayKind: 'used',
    utilizationPercent: 10,
    status: 'ok',
    note: '',
    lastChecked: '2026-09-07T06:00:00.000Z',
    ...overrides,
  };
}

describe('quotaFacetFromPlatform', () => {
  it('reports a healthy pool with its owner ref and observation time', async () => {
    const { quotaFacetFromPlatform } = await load();
    const facet = quotaFacetFromPlatform(platform());

    assert.equal(facet.status, 'ok');
    assert.equal(facet.poolRef, 'quota_platform:claude');
    assert.equal(facet.sourceRef, '/api/quota#platforms.claude');
    assert.equal(facet.observedAt, Date.parse('2026-09-07T06:00:00.000Z'));
  });

  // Reviewed 2026-09-07 (codex-astra): `status: 'ok'` with 100% utilization is
  // not a combination this owner produces. statusFromUtilization returns
  // 'error' at >= 95, so the exhausted case must be tested in that shape.
  it('calls a fully used pool exhausted even though the owner labels it error', async () => {
    const { quotaFacetFromPlatform } = await load();
    const exhausted = quotaFacetFromPlatform(platform({ utilizationPercent: 100, status: 'error' }));
    assert.equal(exhausted.status, 'exhausted');
    assert.equal(exhausted.poolRef, 'quota_platform:claude');
  });

  it('keeps a high-but-not-empty pool low rather than exhausted', async () => {
    const { quotaFacetFromPlatform } = await load();
    assert.equal(quotaFacetFromPlatform(platform({ utilizationPercent: 96, status: 'error' })).status, 'low');
  });

  it('calls a nearly used pool low, before it becomes a surprise', async () => {
    const { quotaFacetFromPlatform } = await load();
    assert.equal(quotaFacetFromPlatform(platform({ utilizationPercent: 93 })).status, 'low');
  });

  it('treats an owner-flagged warning as low even without a number', async () => {
    const { quotaFacetFromPlatform } = await load();
    assert.equal(quotaFacetFromPlatform(platform({ status: 'warn', utilizationPercent: null })).status, 'low');
  });

  // A probe failure is the case with no figure at all.
  it('does not turn a failed probe into a budget reading', async () => {
    const { quotaFacetFromPlatform } = await load();
    assert.equal(quotaFacetFromPlatform(platform({ status: 'error', utilizationPercent: null })), 'owner_unreachable');
  });

  it('reports a pending probe as unknown rather than ok', async () => {
    const { quotaFacetFromPlatform } = await load();
    assert.equal(quotaFacetFromPlatform(platform({ status: 'pending', utilizationPercent: null })), 'unknown');
  });

  it('reports unknown when the owner has no reading at all', async () => {
    const { quotaFacetFromPlatform } = await load();
    assert.equal(quotaFacetFromPlatform(undefined), 'unknown');
    assert.equal(quotaFacetFromPlatform(platform({ utilizationPercent: null, lastChecked: null })), 'unknown');
  });
});
