/**
 * F260 Phase A INV-5: Seeds reload must skip entities with proposal provenance.
 *
 * When the server restarts and reloads entity seeds, it must not overwrite
 * entities that were created via the propose_entity approval flow.
 * This prevents approved entity proposals from being silently replaced
 * by the default seed data on restart.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F260 INV-5: entity seeds skip proposal-provenance entities', () => {
  it('loadEntitySeeds filters entities with proposal provenance from explicit seeds', async () => {
    // This test verifies that the shouldSkipProposalEntity function
    // correctly identifies and filters proposal-sourced entities.
    const { shouldSkipProposalEntity } = await import('../dist/domains/memory/entity-seeds.js');

    // Entity with proposal provenance — should be skipped
    const proposalEntity = {
      entityId: 'concept:未婚喵',
      type: 'concept',
      canonicalName: '未婚喵',
      aliases: ['未婚喵'],
      provenance: [{ source: 'proposal', anchor: 'thread_abc', note: 'Approved via Hub' }],
      updatedAt: '2026-07-09T00:00:00Z',
    };

    // Entity with normal provenance — should NOT be skipped
    const seedEntity = {
      entityId: 'person:landy',
      type: 'person',
      canonicalName: 'You',
      aliases: ['You', 'you'],
      provenance: [{ source: 'entity-seed', anchor: 'config/entity-seeds.json' }],
      updatedAt: '2026-07-09T00:00:00Z',
    };

    // Entity with mixed provenance including proposal — should be skipped
    const mixedEntity = {
      entityId: 'concept:混合',
      type: 'concept',
      canonicalName: '混合',
      aliases: ['混合'],
      provenance: [
        { source: 'entity-seed', anchor: 'config/entity-seeds.json' },
        { source: 'proposal', anchor: 'thread_xyz' },
      ],
      updatedAt: '2026-07-09T00:00:00Z',
    };

    assert.equal(shouldSkipProposalEntity(proposalEntity), true, 'proposal-only entity must be skipped');
    assert.equal(shouldSkipProposalEntity(seedEntity), false, 'normal seed entity must NOT be skipped');
    assert.equal(shouldSkipProposalEntity(mixedEntity), true, 'entity with any proposal provenance must be skipped');
  });

  it('validateEntitySeed preserves explicit stance/visibilityScope/status fields', async () => {
    // Codex review R2 P2: validateEntitySeed was silently dropping these fields.
    // A seed with explicit non-default values must retain them through validation.
    const { loadExplicitEntitySeeds } = await import('../dist/domains/memory/entity-seeds.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = join(tmpdir(), `f260-seed-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const seedPath = join(dir, 'test-seeds.json');
    writeFileSync(
      seedPath,
      JSON.stringify({
        version: 1,
        entities: [
          {
            entityId: 'concept:critique-target',
            type: 'concept',
            canonicalName: 'Critique Target',
            aliases: ['critique-target'],
            stance: 'critique_target',
            visibilityScope: 'workspace',
            status: 'retired',
            provenance: [{ source: 'test', anchor: 'unit-test' }],
            updatedAt: '2026-07-09T00:00:00Z',
          },
        ],
      }),
    );

    const seeds = loadExplicitEntitySeeds(seedPath);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].stance, 'critique_target', 'explicit stance must survive validation');
    assert.equal(seeds[0].visibilityScope, 'workspace', 'explicit visibilityScope must survive validation');
    assert.equal(seeds[0].status, 'retired', 'explicit status must survive validation');
  });

  it('roster entities are never skipped (they have F032 roster provenance)', async () => {
    const { shouldSkipProposalEntity } = await import('../dist/domains/memory/entity-seeds.js');

    const rosterEntity = {
      entityId: 'cat:opus',
      type: 'cat',
      canonicalName: 'opus',
      aliases: ['opus', '@opus'],
      provenance: [{ source: 'F032 roster', anchor: 'cat-template.json' }],
      updatedAt: '2026-07-09T00:00:00Z',
    };

    assert.equal(shouldSkipProposalEntity(rosterEntity), false, 'roster entity must NOT be skipped');
  });
});
