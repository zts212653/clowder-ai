// @ts-check

/**
 * #1049 — Startup self-healing: capabilities.json with missing managed MCPs.
 *
 * When capabilities.json exists but is missing core managed MCP entries
 * (cat-cafe-collab, cat-cafe-memory, cat-cafe-signals, etc.),
 * `healCatCafeMcpTopology` should restore them automatically.
 *
 * Previously, the heal chain could only:
 *   - Migrate legacy cat-cafe → splits (if legacy entry existed)
 *   - Add supplemental splits (if core 3 already existed)
 * It could NOT restore missing core splits from scratch.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { healCatCafeMcpTopology } = await import('../dist/config/capabilities/capability-orchestrator.js');

const CORE_SPLIT_IDS = ['cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'];
const ALL_SPLIT_IDS = [
  'cat-cafe-collab',
  'cat-cafe-memory',
  'cat-cafe-signals',
  'cat-cafe-limb',
  'cat-cafe-audio',
  'cat-cafe-finance',
];

/** A capabilities config with only external MCP (no managed splits at all). */
function configWithNoManagedMcps() {
  return {
    version: 2,
    capabilities: [
      {
        id: 'some-external-mcp',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'node', args: ['ext.js'] },
      },
    ],
  };
}

/** A capabilities config with only 1 of 3 core managed splits. */
function configWithPartialCoreMcps() {
  return {
    version: 2,
    capabilities: [
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        globalEnabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['collab.js'] },
      },
      {
        id: 'some-external-mcp',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'node', args: ['ext.js'] },
      },
    ],
  };
}

/** A capabilities config with skills but no MCPs at all. */
function configWithSkillsOnly() {
  return {
    version: 2,
    capabilities: [
      {
        id: 'some-skill',
        type: 'skill',
        enabled: true,
        source: 'cat-cafe',
      },
    ],
  };
}

describe('#1049 — healCatCafeMcpTopology restores missing managed MCPs', () => {
  it('adds all managed splits when none exist', () => {
    const input = configWithNoManagedMcps();
    const result = healCatCafeMcpTopology(input, { catCafeRepoRoot: '/fake/root' });

    assert.ok(result.migrated, 'should report migration occurred');

    const managedIds = result.config.capabilities
      .filter((c) => c.type === 'mcp' && c.source === 'cat-cafe')
      .map((c) => c.id);

    for (const id of ALL_SPLIT_IDS) {
      assert.ok(managedIds.includes(id), `missing managed MCP: ${id}`);
    }

    // External MCP should be preserved
    const externalMcp = result.config.capabilities.find((c) => c.id === 'some-external-mcp');
    assert.ok(externalMcp, 'external MCP should be preserved');
  });

  it('adds missing core splits when only some exist', () => {
    const input = configWithPartialCoreMcps();
    const result = healCatCafeMcpTopology(input, { catCafeRepoRoot: '/fake/root' });

    assert.ok(result.migrated, 'should report migration occurred');

    const managedIds = result.config.capabilities
      .filter((c) => c.type === 'mcp' && c.source === 'cat-cafe')
      .map((c) => c.id);

    for (const id of CORE_SPLIT_IDS) {
      assert.ok(managedIds.includes(id), `missing core MCP: ${id}`);
    }
  });

  it('adds managed MCPs when only skills exist', () => {
    const input = configWithSkillsOnly();
    const result = healCatCafeMcpTopology(input, { catCafeRepoRoot: '/fake/root' });

    assert.ok(result.migrated, 'should report migration occurred');

    const managedIds = result.config.capabilities
      .filter((c) => c.type === 'mcp' && c.source === 'cat-cafe')
      .map((c) => c.id);

    for (const id of ALL_SPLIT_IDS) {
      assert.ok(managedIds.includes(id), `missing managed MCP: ${id}`);
    }

    // Skills should be preserved
    const skill = result.config.capabilities.find((c) => c.id === 'some-skill');
    assert.ok(skill, 'existing skills should be preserved');
  });

  it('does not duplicate when all managed MCPs already exist', () => {
    // Build a complete config with all managed MCPs
    const config = {
      version: 2,
      capabilities: ALL_SPLIT_IDS.map((id) => ({
        id,
        type: 'mcp',
        enabled: true,
        globalEnabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: [`${id.replace('cat-cafe-', '')}.js`] },
      })),
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });

    // Count managed MCPs — should be exactly 6, not 12
    const managedCount = result.config.capabilities.filter((c) => c.type === 'mcp' && c.source === 'cat-cafe').length;
    assert.equal(managedCount, ALL_SPLIT_IDS.length, 'should not duplicate managed MCPs');
  });

  it('inherits enabled state from existing managed splits', () => {
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: false,
          globalEnabled: false,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated);

    // Newly added splits should inherit the disabled state from existing collab
    const newMemory = result.config.capabilities.find((c) => c.id === 'cat-cafe-memory' && c.source === 'cat-cafe');
    assert.ok(newMemory, 'cat-cafe-memory should be added');
    assert.equal(newMemory.globalEnabled, false, 'should inherit disabled state');
  });

  it('preserves legacy overrides→blockedCats during migration (codex PR #13 P1)', () => {
    // Regression test: legacy `cat-cafe` entry has per-cat overrides.
    // The heal chain must run legacy migration FIRST (overrides→blockedCats),
    // then ensureCoreManagedMcps fills gaps. If ensureCoreManagedMcps ran first,
    // the legacy migration would become a no-op and overrides would be lost,
    // silently re-enabling access for blocked cats.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [
            { catId: 'ragdoll', enabled: false },
            { catId: 'maine-coon', enabled: true },
          ],
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    // Legacy `cat-cafe` entry should be removed (migrated to splits)
    const legacyEntry = result.config.capabilities.find((c) => c.id === 'cat-cafe' && c.source === 'cat-cafe');
    assert.equal(legacyEntry, undefined, 'legacy cat-cafe entry should be removed');

    // All managed splits should exist
    for (const id of ALL_SPLIT_IDS) {
      const split = result.config.capabilities.find((c) => c.id === id && c.source === 'cat-cafe');
      assert.ok(split, `managed split ${id} should exist`);

      // The blocked cat from overrides must be preserved as blockedCats
      assert.ok(
        Array.isArray(split.blockedCats) && split.blockedCats.includes('ragdoll'),
        `${id} must have ragdoll in blockedCats (legacy overrides preservation)`,
      );
    }
  });

  it('preserves legacy overrides in partial-legacy form (codex PR #13 re-review P1)', () => {
    // Regression test: legacy `cat-cafe` with overrides PLUS an existing managed
    // split (cat-cafe-collab). migrateLegacyCatCafeCapability bails because
    // hasManagedSplit=true; ensureCoreManagedMcps must:
    //   1. Propagate legacy overrides→blockedCats to newly added splits
    //   2. Propagate legacy overrides→blockedCats to the existing split (cat-cafe-collab)
    // Without this fix, ensureCatCafeMainServer removes legacy `cat-cafe` and
    // all splits end up with blockedCats=undefined — silently re-enabling blocked cats.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [
            { catId: 'codex', enabled: false },
            { catId: 'ragdoll', enabled: true },
          ],
        },
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
          // No blockedCats — the partial split was created without overrides conversion
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    // Legacy `cat-cafe` entry should be removed
    const legacyEntry = result.config.capabilities.find((c) => c.id === 'cat-cafe' && c.source === 'cat-cafe');
    assert.equal(legacyEntry, undefined, 'legacy cat-cafe entry should be removed');

    // ALL managed splits (including pre-existing cat-cafe-collab) must have blockedCats
    for (const id of ALL_SPLIT_IDS) {
      const split = result.config.capabilities.find((c) => c.id === id && c.source === 'cat-cafe');
      assert.ok(split, `managed split ${id} should exist`);

      assert.ok(
        Array.isArray(split.blockedCats) && split.blockedCats.includes('codex'),
        `${id} must have codex in blockedCats (partial-legacy overrides propagation)`,
      );

      // ragdoll was enabled:true in overrides — should NOT appear in blockedCats
      assert.ok(
        !split.blockedCats.includes('ragdoll'),
        `${id} must NOT have ragdoll in blockedCats (ragdoll was allowed)`,
      );
    }
  });

  it('preserves existing blockedCats when legacy overrides are also present', () => {
    // Edge case: existing split already has its own blockedCats.
    // Legacy overrides should NOT overwrite explicit blockedCats on existing splits.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [{ catId: 'codex', enabled: false }],
        },
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
          blockedCats: ['siamese'],
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    // cat-cafe-collab had explicit blockedCats — those should be preserved, not overwritten
    const collab = result.config.capabilities.find((c) => c.id === 'cat-cafe-collab' && c.source === 'cat-cafe');
    assert.ok(collab, 'cat-cafe-collab should exist');
    assert.ok(
      Array.isArray(collab.blockedCats) && collab.blockedCats.includes('siamese'),
      'cat-cafe-collab should keep its original blockedCats',
    );

    // Newly added splits (no pre-existing blockedCats) should get legacy overrides
    const memory = result.config.capabilities.find((c) => c.id === 'cat-cafe-memory' && c.source === 'cat-cafe');
    assert.ok(memory, 'cat-cafe-memory should exist');
    assert.ok(
      Array.isArray(memory.blockedCats) && memory.blockedCats.includes('codex'),
      'cat-cafe-memory should inherit codex from legacy overrides',
    );
  });

  it('applies legacy overrides to existing splits with empty blockedCats array (bot P1)', () => {
    // Edge case: existing split has blockedCats: [] (e.g., from MCP global-new sync).
    // Empty array should be treated as "no blocks set yet" — legacy overrides apply.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [{ catId: 'codex', enabled: false }],
        },
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
          blockedCats: [],
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    const collab = result.config.capabilities.find((c) => c.id === 'cat-cafe-collab' && c.source === 'cat-cafe');
    assert.ok(collab, 'cat-cafe-collab should exist');
    assert.ok(
      Array.isArray(collab.blockedCats) && collab.blockedCats.includes('codex'),
      'cat-cafe-collab with empty blockedCats should receive legacy overrides',
    );
  });

  it('unions legacy blockedCats into existing splits with partial blockedCats (codex R13 P1)', () => {
    // Regression: a pre-existing split already has blockedCats: ['catA'] but
    // legacy main blocks both 'catA' and 'catB'. The migration must union them
    // (not skip non-empty lists), otherwise removing the legacy entry silently
    // unblocks 'catB' on that split.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [
            { catId: 'codex', enabled: false },
            { catId: 'gemini', enabled: false },
          ],
        },
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
          blockedCats: ['codex'],
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    const collab = result.config.capabilities.find((c) => c.id === 'cat-cafe-collab' && c.source === 'cat-cafe');
    assert.ok(collab, 'cat-cafe-collab should exist');
    assert.ok(
      Array.isArray(collab.blockedCats) && collab.blockedCats.includes('codex'),
      'cat-cafe-collab should keep existing blocked cat',
    );
    assert.ok(
      collab.blockedCats.includes('gemini'),
      'cat-cafe-collab should also receive legacy-blocked gemini (union, not skip)',
    );
  });

  it('inherits legacy main disabled/env/workingDir over existing splits (codex PR #13 R3 P1)', () => {
    // Regression test: 3 core splits exist + legacy main with disabled state,
    // custom env, and workingDir. ensureCoreManagedMcps adds supplemental splits
    // (limb/audio/finance) and must inherit from legacy main (P1 priority), NOT
    // from the first existing split. Legacy main represents user intent for these
    // tools since it hosted them via registerFullToolset.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: false,
          globalEnabled: false,
          source: 'cat-cafe',
          mcpServer: {
            command: 'node',
            args: ['index.js'],
            env: { CUSTOM_VAR: 'legacy-value' },
            workingDir: '/legacy/working/dir',
          },
          overrides: [{ catId: 'codex', enabled: false }],
        },
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
        },
        {
          id: 'cat-cafe-memory',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['memory.js'] },
        },
        {
          id: 'cat-cafe-signals',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['signals.js'] },
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    // Legacy main should be removed
    const legacyEntry = result.config.capabilities.find((c) => c.id === 'cat-cafe' && c.source === 'cat-cafe');
    assert.equal(legacyEntry, undefined, 'legacy cat-cafe entry should be removed');

    // Supplemental splits (limb/audio/finance) must inherit from legacy main, NOT from collab
    for (const id of ['cat-cafe-limb', 'cat-cafe-audio', 'cat-cafe-finance']) {
      const split = result.config.capabilities.find((c) => c.id === id && c.source === 'cat-cafe');
      assert.ok(split, `${id} should exist`);

      // enabled/globalEnabled from legacy main (disabled)
      assert.equal(split.enabled, false, `${id} should inherit disabled from legacy main`);
      assert.equal(split.globalEnabled, false, `${id} should inherit globalEnabled=false from legacy main`);

      // env from legacy main
      assert.deepEqual(
        split.mcpServer?.env,
        { CUSTOM_VAR: 'legacy-value' },
        `${id} should inherit env from legacy main`,
      );

      // workingDir from legacy main
      assert.equal(
        split.mcpServer?.workingDir,
        '/legacy/working/dir',
        `${id} should inherit workingDir from legacy main`,
      );

      // blockedCats from legacy overrides
      assert.ok(
        Array.isArray(split.blockedCats) && split.blockedCats.includes('codex'),
        `${id} should have codex in blockedCats from legacy overrides`,
      );
    }
  });

  it('does not inherit from or propagate overrides to plugin MCPs (upstream review P2)', () => {
    // Plugin MCPs have source='cat-cafe' + pluginId. They should NOT be used
    // as inheritFrom source (would leak plugin env/disabled state to core splits)
    // and should NOT receive legacy overrides (would block cats from unrelated plugins).
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [{ catId: 'codex', enabled: false }],
        },
        {
          id: 'my-plugin-mcp',
          type: 'mcp',
          enabled: false,
          globalEnabled: false,
          source: 'cat-cafe',
          pluginId: 'my-plugin',
          mcpServer: { command: 'node', args: ['plugin.js'], env: { PLUGIN_KEY: 'secret' } },
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    // All 6 managed splits should exist and be enabled (from legacy main, which was enabled)
    for (const id of ALL_SPLIT_IDS) {
      const split = result.config.capabilities.find((c) => c.id === id && c.source === 'cat-cafe' && !c.pluginId);
      assert.ok(split, `${id} should exist`);
      // Should NOT inherit plugin's disabled state or env
      assert.equal(split.enabled, true, `${id} should inherit enabled from legacy main, not from plugin`);
      assert.equal(split.mcpServer?.env?.PLUGIN_KEY, undefined, `${id} should not have plugin env`);
      // SHOULD have legacy blockedCats
      assert.ok(
        Array.isArray(split.blockedCats) && split.blockedCats.includes('codex'),
        `${id} should have legacy blockedCats`,
      );
    }

    // Plugin MCP should NOT have legacy blockedCats applied
    const plugin = result.config.capabilities.find((c) => c.id === 'my-plugin-mcp');
    assert.ok(plugin, 'plugin MCP should still exist');
    assert.ok(
      !plugin.blockedCats || !plugin.blockedCats.includes('codex'),
      'plugin MCP should NOT receive legacy blockedCats',
    );
  });

  it('does not add partial splits when legacy exists and some IDs are collision-blocked (upstream P2)', () => {
    // Scenario: legacy `cat-cafe` coexists with a non-managed MCP that owns
    // a split id (e.g., user-created `cat-cafe-collab` with source='external').
    // migrateLegacyCatCafeCapability bails (hasManagedSplit=false, but collision).
    // ensureCoreManagedMcps must NOT add partial splits — legacy all-in-one +
    // partial split servers would expose duplicate tools, and ensureCatCafeMainServer
    // can't remove legacy without the full set.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
        },
        {
          // Non-managed MCP that owns a split id — collision blocker
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'node', args: ['user-collab.js'] },
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });

    // Legacy `cat-cafe` should still exist (can't be removed without full split set)
    const legacyEntry = result.config.capabilities.find((c) => c.id === 'cat-cafe' && c.source === 'cat-cafe');
    assert.ok(legacyEntry, 'legacy cat-cafe entry should be preserved');

    // The non-managed collision blocker should be untouched
    const collisionBlocker = result.config.capabilities.find(
      (c) => c.id === 'cat-cafe-collab' && c.source === 'external',
    );
    assert.ok(collisionBlocker, 'collision blocker should be preserved');

    // No managed split servers should be added (all-or-nothing)
    const addedSplits = result.config.capabilities.filter(
      (c) => c.type === 'mcp' && c.source === 'cat-cafe' && c.id !== 'cat-cafe',
    );
    assert.equal(
      addedSplits.length,
      0,
      'no managed splits should be added when legacy + collision (duplicate tool prevention)',
    );
  });
});
