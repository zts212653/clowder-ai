/**
 * F168 Phase C — C1.1: CommunityRole / RoleCapability contract (shared Role Registry types)
 *
 * Tests the genuinely-runtime surface of the Role Registry type module:
 *   - COMMUNITY_ROLES  bounded set  (INV-4 foundation: role 名封闭集)
 *   - isCommunityRole  fail-closed membership guard (INV-4: unknown → false, 不静默)
 *   - ROLE_CAPABILITIES excludes code/merge/worktree (INV-2 foundation: narrator 能力受限)
 *   - isRoleCapability  membership guard
 *
 * NOTE (TDD honesty): the RoleResolver.resolve() contract
 *   (resolve('narrator') → executor, resolve('bogus') → null + warning, INV-4/INV-5)
 * is tested against the REAL implementation in C1.2 (role-resolver.test.js).
 * Testing resolve() here against a stub would test a mock, not real code.
 * C1.1 owns the type module's runtime primitives (the fail-closed building blocks).
 *
 * Lives under packages/api/test/community/ (not packages/shared/test/) so it runs in
 * the gated api suite (test/**\/*.test.js) alongside C1.2/C1.3, instead of the
 * un-wired packages/shared/test/ that root `pnpm test` skips.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F168 Phase C C1.1: CommunityRole + RoleCapability contract', () => {
  describe('COMMUNITY_ROLES — bounded set (INV-4)', () => {
    it('is exactly {narrator, case-owner, reconciler}', async () => {
      const { COMMUNITY_ROLES } = await import('@cat-cafe/shared');
      assert.deepEqual(
        [...COMMUNITY_ROLES].sort(),
        ['case-owner', 'narrator', 'reconciler'],
        'CommunityRole must be the closed set of three engine roles',
      );
    });
  });

  describe('isCommunityRole — fail-closed membership (INV-4)', () => {
    it('accepts the three known roles', async () => {
      const { isCommunityRole } = await import('@cat-cafe/shared');
      assert.equal(isCommunityRole('narrator'), true);
      assert.equal(isCommunityRole('case-owner'), true);
      assert.equal(isCommunityRole('reconciler'), true);
    });

    it('rejects unknown / malformed values (fail-closed, 不静默吞)', async () => {
      const { isCommunityRole } = await import('@cat-cafe/shared');
      assert.equal(isCommunityRole('bogus'), false);
      assert.equal(isCommunityRole(''), false);
      assert.equal(isCommunityRole('Narrator'), false, 'case-sensitive — no fuzzy match');
      assert.equal(isCommunityRole('case_owner'), false, 'underscore is not the hyphen form');
      assert.equal(isCommunityRole(null), false);
      assert.equal(isCommunityRole(undefined), false);
      assert.equal(isCommunityRole(123), false);
      assert.equal(isCommunityRole({}), false);
    });
  });

  describe('ROLE_CAPABILITIES — narrator capability ceiling (INV-2)', () => {
    it('is exactly {triage, route-recommend, public-reply}', async () => {
      const { ROLE_CAPABILITIES } = await import('@cat-cafe/shared');
      assert.deepEqual([...ROLE_CAPABILITIES].sort(), ['public-reply', 'route-recommend', 'triage']);
    });

    it('explicitly excludes code / merge / worktree (engine power separation)', async () => {
      const { ROLE_CAPABILITIES } = await import('@cat-cafe/shared');
      for (const forbidden of ['code', 'merge', 'worktree']) {
        assert.equal(
          ROLE_CAPABILITIES.includes(forbidden),
          false,
          `RoleCapability must NOT include '${forbidden}' — community roles never write code (INV-2)`,
        );
      }
    });
  });

  describe('isRoleCapability — membership guard', () => {
    it('accepts known capabilities, rejects code/unknown/malformed', async () => {
      const { isRoleCapability } = await import('@cat-cafe/shared');
      assert.equal(isRoleCapability('triage'), true);
      assert.equal(isRoleCapability('route-recommend'), true);
      assert.equal(isRoleCapability('public-reply'), true);
      assert.equal(isRoleCapability('code'), false);
      assert.equal(isRoleCapability('merge'), false);
      assert.equal(isRoleCapability('worktree'), false);
      assert.equal(isRoleCapability(null), false);
      assert.equal(isRoleCapability(undefined), false);
    });
  });
});
