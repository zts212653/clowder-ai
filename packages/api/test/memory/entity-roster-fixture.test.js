import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRosterEntitySeeds } from '../../dist/domains/memory/entity-seeds.js';

test('explicit roster fixtures preserve specific aliases without promoting shared names', () => {
  const seeds = buildRosterEntitySeeds({
    breeds: [
      {
        id: 'fixture-breed',
        catId: 'fixture-main',
        name: 'fixture-main',
        displayName: 'Fixture Breed',
        nickname: 'shared-nickname',
        mentionPatterns: ['@fixture-main', '@Fixture Breed'],
        defaultVariantId: 'main',
        variants: [
          { id: 'main', catId: 'fixture-main', clientId: 'codex', defaultModel: 'fixture-model' },
          {
            id: 'alt',
            catId: 'fixture-alt',
            clientId: 'codex',
            defaultModel: 'fixture-model',
            name: 'Specific Variant',
            displayName: 'Specific Variant',
            variantLabel: 'Variant',
            mentionPatterns: ['@fixture-alt', '@variant-route'],
          },
        ],
      },
    ],
  });
  const main = seeds.find((e) => e.entityId === 'cat:fixture-main');
  const alt = seeds.find((e) => e.entityId === 'cat:fixture-alt');
  assert.equal(main.canonicalName, 'fixture-main');
  assert.equal(alt.canonicalName, 'Specific Variant');
  assert.ok(main.aliases.includes('@Fixture Breed'));
  assert.ok(alt.aliases.includes('@variant-route'));
  for (const seed of seeds) {
    assert.equal(seed.aliases.includes('Fixture Breed'), false);
    assert.equal(seed.aliases.includes('fixture-breed'), false);
    assert.equal(seed.aliases.includes('shared-nickname'), false);
    assert.equal(seed.aliases.includes('Variant'), false);
    assert.equal(seed.provenance[0].source, 'F032 roster');
  }
});
