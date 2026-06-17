/**
 * F168 Phase C — C1.2: createRoleResolver (家里 roster binding, aligned with ActorResolver)
 *
 * The community engine routes by role, never cat name (INV-6). RoleResolver is the家里 binding
 * layer — the ONE place allowed to know cat names — implementing the shared RoleResolver contract.
 * It maps CommunityRole → RoleExecutor via deployment bindings, validating availability against an
 * injected roster (ActorResolver-style, so tests inject mock rosters without the cat-config singleton).
 *
 * Covers:
 *   - contract: resolve('narrator') with a valid binding + available cat → RoleExecutor
 *   - INV-4: resolve(unknown role) → null + observable 'unknown-role' (fail-closed, 不静默)
 *   - INV-5: unbound role / cat-not-in-roster / cat-unavailable → null + observable reason
 *   - INV-2: resolved narrator capabilities exclude code/merge/worktree
 *   - adversarial: resolve reads a single consistent roster snapshot (config hot-reload safety)
 *   - 家里 default: DEFAULT_COMMUNITY_ROLE_BINDINGS binds narrator → gemini25, cheap pinned model
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RESOLVER = '../../dist/domains/community/RoleResolver.js';
const CAT_CONFIG_LOADER = '../../dist/config/cat-config-loader.js';
const CAT_TEMPLATE_PATH = fileURLToPath(new URL('../../../../cat-template.json', import.meta.url));

const validRoster = () => ({ gemini25: { available: true }, 'opus-48': { available: true } });
const narratorBinding = {
  catId: 'gemini25',
  model: 'gemini-3.5-flash',
  promptTemplateId: 'community-narrator-v1',
  capabilities: ['triage', 'route-recommend', 'public-reply'],
};
const recordWarnings = () => {
  const warnings = [];
  return { warnings, onUnresolved: (role, reason) => warnings.push([role, reason]) };
};

describe('F168 Phase C C1.2: createRoleResolver (家里 roster binding)', () => {
  it('resolve(narrator) with bound + available cat → RoleExecutor', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    const resolver = createRoleResolver(validRoster, { narrator: narratorBinding });
    const ex = resolver.resolve('narrator');
    assert.ok(ex, 'expected a RoleExecutor');
    assert.equal(ex.catId, 'gemini25');
    assert.equal(ex.model, 'gemini-3.5-flash');
    assert.equal(ex.promptTemplateId, 'community-narrator-v1');
    assert.deepEqual([...ex.capabilities].sort(), ['public-reply', 'route-recommend', 'triage']);
  });

  it('resolve(unknown role) → null + onUnresolved("unknown-role") [INV-4 fail-closed]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    const { warnings, onUnresolved } = recordWarnings();
    const resolver = createRoleResolver(validRoster, { narrator: narratorBinding }, { onUnresolved });
    assert.equal(resolver.resolve('bogus'), null);
    assert.deepEqual(warnings, [['bogus', 'unknown-role']]);
  });

  it('resolve(narrator) with NO binding → null + onUnresolved("unbound") [INV-5]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    const { warnings, onUnresolved } = recordWarnings();
    const resolver = createRoleResolver(validRoster, {}, { onUnresolved });
    assert.equal(resolver.resolve('narrator'), null);
    assert.deepEqual(warnings, [['narrator', 'unbound']]);
  });

  it('resolve(narrator) bound but cat absent from roster → null + "cat-not-in-roster" [INV-5]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    const { warnings, onUnresolved } = recordWarnings();
    const resolver = createRoleResolver(() => ({}), { narrator: narratorBinding }, { onUnresolved });
    assert.equal(resolver.resolve('narrator'), null);
    assert.deepEqual(warnings, [['narrator', 'cat-not-in-roster']]);
  });

  it('resolve(narrator) bound but cat unavailable → null + "cat-unavailable" [INV-5, 40刀教训]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    const { warnings, onUnresolved } = recordWarnings();
    const resolver = createRoleResolver(
      () => ({ gemini25: { available: false } }),
      { narrator: narratorBinding },
      { onUnresolved },
    );
    assert.equal(resolver.resolve('narrator'), null);
    assert.deepEqual(warnings, [['narrator', 'cat-unavailable']]);
  });

  it('resolved narrator capabilities exclude code/merge/worktree [INV-2]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    const resolver = createRoleResolver(validRoster, { narrator: narratorBinding });
    const ex = resolver.resolve('narrator');
    for (const forbidden of ['code', 'merge', 'worktree']) {
      assert.equal(ex.capabilities.includes(forbidden), false, `narrator must not hold '${forbidden}'`);
    }
  });

  it('resolve(narrator) with an out-of-ceiling capability (runtime config drift) → null + "invalid-capability" [INV-2 fail-closed]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    const { warnings, onUnresolved } = recordWarnings();
    // Deployment bindings are not TS literals at runtime — `readonly RoleCapability[]` is only a
    // compile-time hint. A drifted/deserialized binding can carry a capability outside the INV-2
    // ceiling; resolve() must re-validate at the trust boundary (mirroring the isCommunityRole role
    // check, INV-4), failing closed rather than handing the engine an out-of-ceiling power.
    const drifted = { ...narratorBinding, capabilities: ['triage', 'code'] };
    const resolver = createRoleResolver(validRoster, { narrator: drifted }, { onUnresolved });
    assert.equal(resolver.resolve('narrator'), null);
    assert.deepEqual(warnings, [['narrator', 'invalid-capability']]);
  });

  it('resolve(narrator) with non-array / missing capabilities → null + "invalid-capability" [INV-2 fail-closed]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    const { warnings, onUnresolved } = recordWarnings();
    // A deserialized binding may omit the field entirely; resolve() must not throw on `.every`.
    const broken = { ...narratorBinding, capabilities: undefined };
    const resolver = createRoleResolver(validRoster, { narrator: broken }, { onUnresolved });
    assert.equal(resolver.resolve('narrator'), null);
    assert.deepEqual(warnings, [['narrator', 'invalid-capability']]);
  });

  it('resolve(narrator) with missing required binding strings → null + "invalid-binding" [fail-closed]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    for (const field of ['catId', 'model', 'promptTemplateId']) {
      const { warnings, onUnresolved } = recordWarnings();
      const broken = { ...narratorBinding, [field]: undefined };
      const resolver = createRoleResolver(validRoster, { narrator: broken }, { onUnresolved });
      assert.equal(resolver.resolve('narrator'), null, `${field} must be required at runtime`);
      assert.deepEqual(warnings, [['narrator', 'invalid-binding']]);
    }
  });

  it('reads a single consistent roster snapshot per resolve [adversarial: config hot-reload]', async () => {
    const { createRoleResolver } = await import(RESOLVER);
    let calls = 0;
    const getRoster = () => {
      calls++;
      return { gemini25: { available: true } };
    };
    const resolver = createRoleResolver(getRoster, { narrator: narratorBinding });
    resolver.resolve('narrator');
    assert.equal(calls, 1, 'resolve must read roster exactly once (consistent snapshot, no mid-mutation read)');
  });

  describe('DEFAULT_COMMUNITY_ROLE_BINDINGS (家里 default config)', () => {
    it('binds narrator → gemini25 with a cheap pinned model + restricted capabilities', async () => {
      const { DEFAULT_COMMUNITY_ROLE_BINDINGS } = await import(RESOLVER);
      const n = DEFAULT_COMMUNITY_ROLE_BINDINGS.narrator;
      assert.ok(n, 'narrator must have a default binding');
      assert.equal(n.catId, 'gemini25', 'default narrator binding uses gemini25 catId');
      assert.equal(n.model, 'gemini-3.5-flash');
      for (const forbidden of ['code', 'merge', 'worktree']) {
        assert.equal(
          n.capabilities.includes(forbidden),
          false,
          `default narrator binding must not grant '${forbidden}' [INV-2]`,
        );
      }
    });

    it('default bindings resolve against a roster where gemini25 is available', async () => {
      const { createRoleResolver, DEFAULT_COMMUNITY_ROLE_BINDINGS } = await import(RESOLVER);
      const resolver = createRoleResolver(validRoster, DEFAULT_COMMUNITY_ROLE_BINDINGS);
      const ex = resolver.resolve('narrator');
      assert.ok(ex, 'default narrator binding should resolve when gemini25 is available');
      assert.equal(ex.catId, 'gemini25');
    });

    it('default bindings resolve against the repo template roster (production wiring shape)', async () => {
      const { getRoster, loadCatConfig } = await import(CAT_CONFIG_LOADER);
      const { createRoleResolver, DEFAULT_COMMUNITY_ROLE_BINDINGS } = await import(RESOLVER);
      const resolver = createRoleResolver(
        () => getRoster(loadCatConfig(CAT_TEMPLATE_PATH)),
        DEFAULT_COMMUNITY_ROLE_BINDINGS,
      );
      const ex = resolver.resolve('narrator');
      assert.ok(ex, 'default narrator binding must resolve against cat-template.json roster');
      assert.equal(ex.catId, 'gemini25');
    });
  });
});
