import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { compileL0 } from '../../../scripts/compile-system-prompt-l0.mjs';
import {
  _resetCachedConfig,
  loadCatConfig,
  loadResolvedCatConfig,
  toAllCatConfigs,
} from '../dist/config/cat-config-loader.js';
import { buildTeammateRoster } from '../dist/domains/cats/services/context/SystemPromptBuilder.js';
import { writeDossierFixture } from './helpers/dossier-fixture.js';

const originalTemplate = process.env.CAT_TEMPLATE_PATH;
beforeEach(() => catRegistry.reset());
afterEach(() => {
  catRegistry.reset();
  _resetCachedConfig();
  if (originalTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
  else process.env.CAT_TEMPLATE_PATH = originalTemplate;
});

function prepare(override) {
  const root = mkdtempSync(join(tmpdir(), 'member-identity-authority-'));
  const template = JSON.parse(readFileSync(resolve('../../cat-template.json'), 'utf8'));
  const breed = {
    ...template.breeds[0],
    id: 'fable-breed',
    catId: 'fable-5',
    name: 'Fixture',
    displayName: 'Fixture',
    roleDescription: 'template role',
    teamStrengths: 'template strengths',
    mentionPatterns: ['@fable-5'],
    defaultVariantId: 'fable-default',
    variants: [
      {
        id: 'fable-default',
        clientId: 'openai',
        carrier: 'cli',
        defaultModel: 'fixture-model',
        mcpSupport: false,
        personality: 'template personality',
      },
    ],
  };
  const templatePath = join(root, 'cat-template.json');
  writeFileSync(templatePath, JSON.stringify({ ...template, breeds: [breed], roster: {} }));
  if (override) {
    mkdirSync(join(root, '.cat-cafe'));
    writeFileSync(
      join(root, '.cat-cafe/cat-catalog.json'),
      JSON.stringify({
        version: 2,
        breeds: [
          {
            id: breed.id,
            catId: breed.catId,
            defaultVariantId: 'fable-default',
            variants: [{ id: 'fable-default', ...override }],
          },
        ],
      }),
    );
  }
  writeDossierFixture(root);
  process.env.CAT_TEMPLATE_PATH = templatePath;
  const config = toAllCatConfigs(loadResolvedCatConfig(templatePath));
  catRegistry.register('fable-5', config['fable-5']);
  return { root, config: config['fable-5'] };
}

test('configured identity wins over dossier in the actual L0 and teammate roster', async () => {
  const { root, config } = prepare({
    roleDescription: '新角色',
    personality: '新性格',
    teamStrengths: '新团队定位',
    caution: null,
  });
  const l0 = await compileL0({ catId: 'fable-5', dossierRoot: root, profileDir: root });
  assert.match(l0, /角色：新角色/);
  assert.match(l0, /性格：新性格/);
  assert.doesNotMatch(l0, /fixture-self-canary/);
  const roster = buildTeammateRoster('observer', root);
  assert.match(roster, /新团队定位/);
  assert.doesNotMatch(roster, /fixture-roster-canary/);
  assert.equal(config.identitySources.roleDescription, 'variant');
});

test('template-only historical identity keeps dossier compatibility with provenance', async () => {
  const { root, config } = prepare();
  assert.equal(config.identitySources.roleDescription, 'template');
  const l0 = await compileL0({ catId: 'fable-5', dossierRoot: root, profileDir: root });
  assert.match(l0, /fixture-self-canary/);
  assert.match(buildTeammateRoster('observer', root), /fixture-roster-canary/);
});

test('an explicit empty identity is authoritative and cannot resurrect dossier text', async () => {
  const { root, config } = prepare({ personality: '', teamStrengths: '', caution: null });
  assert.equal(config.personality, '');
  const l0 = await compileL0({ catId: 'fable-5', dossierRoot: root, profileDir: root });
  assert.doesNotMatch(l0, /fixture-self-canary/);
  assert.doesNotMatch(buildTeammateRoster('observer', root), /fixture-roster-canary/);
});

test('an explicitly supplied complete config is authoritative rather than treated as a template fallback', async () => {
  const { root } = prepare();
  const explicit = toAllCatConfigs(loadCatConfig(join(root, 'cat-template.json')))['fable-5'];
  catRegistry.reset();
  catRegistry.register('fable-5', explicit);
  const l0 = await compileL0({ catId: 'fable-5', dossierRoot: root, profileDir: root });
  assert.match(l0, /角色：template role/);
  assert.doesNotMatch(l0, /fixture-self-canary/);
  assert.equal(explicit.identitySources.roleDescription, 'breed');
});

function prepareInheritedVariant(personality) {
  const { root } = prepare();
  const path = join(root, 'cat-template.json');
  const template = JSON.parse(readFileSync(path, 'utf8'));
  const breed = template.breeds[0];
  const primary = { ...breed.variants[0], catId: 'primary' };
  const secondary = {
    ...primary,
    id: 'secondary',
    catId: 'fable-5',
    displayName: 'Secondary',
    roleDescription: 'own template role',
    personality,
  };
  breed.variants = [primary, secondary];
  writeFileSync(path, JSON.stringify(template));
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(
    join(root, '.cat-cafe/cat-catalog.json'),
    JSON.stringify({
      version: 2,
      breeds: [
        {
          id: breed.id,
          catId: breed.catId,
          defaultVariantId: primary.id,
          name: 'edited breed name',
          roleDescription: 'edited breed role',
          variants: [
            { id: primary.id, catId: 'primary', personality: 'edited default personality' },
            { id: secondary.id, catId: 'fable-5' },
          ],
        },
      ],
    }),
  );
  const configs = toAllCatConfigs(loadResolvedCatConfig(path));
  catRegistry.reset();
  Object.entries(configs).forEach(([id, config]) => catRegistry.register(id, config));
  return { root, config: configs['fable-5'] };
}

for (const personality of ['own template personality', '']) {
  test(`an untouched secondary keeps its actual template winners (${personality || 'empty'})`, async () => {
    const { root, config } = prepareInheritedVariant(personality);
    assert.equal(config.personality, personality);
    assert.equal(config.name, 'Secondary');
    assert.equal(config.roleDescription, 'own template role');
    assert.deepEqual(
      {
        personality: config.identitySources.personality,
        name: config.identitySources.name,
        roleDescription: config.identitySources.roleDescription,
      },
      { personality: 'template', name: 'template', roleDescription: 'template' },
    );
    assert.match(await compileL0({ catId: 'fable-5', dossierRoot: root, profileDir: root }), /fixture-self-canary/);
    assert.match(buildTeammateRoster('primary', root), /fixture-roster-canary/);
  });
}

test('a secondary without its own personality actually inherits the edited default', () => {
  const { config } = prepareInheritedVariant(undefined);
  assert.equal(config.personality, 'edited default personality');
  assert.equal(config.identitySources.personality, 'default_variant');
});
