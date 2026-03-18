import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { bootstrapCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
const {
  createRuntimeCat,
  deleteRuntimeCat,
  readRuntimeCatCatalog,
  updateRuntimeCat,
} = await import('../dist/config/runtime-cat-catalog.js');

function validConfig() {
  return {
    version: 2,
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        avatar: '/avatars/opus.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@opus', '@布偶猫'],
        roleDescription: '主架构师',
        defaultVariantId: 'opus-default',
        variants: [
          {
            id: 'opus-default',
            provider: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
        ],
      },
    ],
    roster: {
      opus: {
        family: 'ragdoll',
        roles: ['architect'],
        lead: true,
        available: true,
        evaluation: 'primary',
      },
    },
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    owner: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

describe('cat-catalog-store', () => {
  it('bootstraps .cat-cafe/cat-catalog.json from cat-template.json', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    assert.equal(catalogPath, resolveCatCatalogPath(projectRoot));
    assert.ok(existsSync(catalogPath), 'runtime catalog should be created');
    assert.deepEqual(JSON.parse(readFileSync(catalogPath, 'utf-8')), template);
  });

  it('keeps existing .cat-cafe/cat-catalog.json instead of overwriting runtime edits', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));

    const runtimeConfig = validConfig();
    runtimeConfig.breeds[0].displayName = '运行时布偶猫';
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(runtimeConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    assert.deepEqual(JSON.parse(readFileSync(catalogPath, 'utf-8')), runtimeConfig);
  });

  it('creates a new runtime member without corrupting v2 top-level fields', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    await createRuntimeCat(projectRoot, {
      catId: 'spark-lite',
      breedId: 'spark-lite',
      name: '火花猫',
      displayName: '火花猫',
      avatar: '/avatars/spark.png',
      color: { primary: '#f97316', secondary: '#fed7aa' },
      mentionPatterns: ['@spark-lite', '@火花猫'],
      roleDescription: '快速执行',
      personality: '利落',
      provider: 'openai',
      defaultModel: 'gpt-5.4-mini',
      mcpSupport: false,
      cli: { command: 'codex', outputFormat: 'json' },
    });

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(catalog.version, 2);
    assert.equal(catalog.owner?.name, 'Co-worker');
    assert.equal(catalog.reviewPolicy?.preferLead, true);
    assert.ok(catalog.roster?.opus, 'existing roster must be preserved');
    const created = catalog.breeds.find((breed) => breed.catId === 'spark-lite');
    assert.ok(created, 'spark-lite breed should be created');
    assert.equal(created.displayName, '火花猫');
    assert.deepEqual(created.mentionPatterns, ['@spark-lite', '@火花猫']);
    assert.equal(created.variants[0]?.provider, 'openai');
  });

  it('updates an existing runtime member in place', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    await updateRuntimeCat(projectRoot, 'opus', {
      displayName: '运行时布偶猫',
      mentionPatterns: ['@opus', '@布偶猫', '@运行时布偶'],
      defaultModel: 'claude-opus-4-1',
      personality: '更严格',
    });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const updated = catalog.breeds.find((breed) => breed.catId === 'opus');
    assert.ok(updated, 'opus breed should still exist');
    assert.equal(updated.displayName, '运行时布偶猫');
    assert.deepEqual(updated.mentionPatterns, ['@opus', '@布偶猫', '@运行时布偶']);
    assert.equal(updated.variants[0]?.defaultModel, 'claude-opus-4-1');
    assert.equal(updated.variants[0]?.personality, '更严格');
    assert.equal(catalog.owner?.mentionPatterns[0], '@co-worker');
  });

  it('does not overwrite runtime catalog when validation fails', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    const catalogPath = resolveCatCatalogPath(projectRoot);
    const beforeRaw = readFileSync(catalogPath, 'utf-8');

    assert.throws(
      () => {
        updateRuntimeCat(projectRoot, 'opus', { defaultModel: '' });
      },
      /Invalid cat config/i,
    );

    const afterRaw = readFileSync(catalogPath, 'utf-8');
    assert.equal(afterRaw, beforeRaw, 'failed update must not corrupt persisted runtime catalog');
  });

  it('rejects runtime members that reuse an alias from another cat', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    const catalogPath = resolveCatCatalogPath(projectRoot);
    const beforeRaw = readFileSync(catalogPath, 'utf-8');

    assert.throws(
      () => {
        createRuntimeCat(projectRoot, {
          catId: 'spark-lite',
          breedId: 'spark-lite',
          name: '火花猫',
          displayName: '火花猫',
          avatar: '/avatars/spark.png',
          color: { primary: '#f97316', secondary: '#fed7aa' },
          mentionPatterns: ['@opus', '@spark-lite'],
          roleDescription: '快速执行',
          provider: 'openai',
          defaultModel: 'gpt-5.4',
          mcpSupport: false,
          cli: { command: 'codex', outputFormat: 'json' },
        });
      },
      /mention alias "@opus" is already used by cat "opus"/i,
    );

    const afterRaw = readFileSync(catalogPath, 'utf-8');
    assert.equal(afterRaw, beforeRaw, 'failed create must not mutate runtime catalog');
  });

  it('deletes a runtime-created member without touching the rest of the catalog', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    await createRuntimeCat(projectRoot, {
      catId: 'temp-cat',
      breedId: 'temp-cat',
      name: '临时猫',
      displayName: '临时猫',
      avatar: '/avatars/temp.png',
      color: { primary: '#64748b', secondary: '#cbd5e1' },
      mentionPatterns: ['@temp-cat'],
      roleDescription: '临时成员',
      personality: '临时',
      provider: 'dare',
      defaultModel: 'dare-1',
      mcpSupport: false,
      cli: { command: 'dare', outputFormat: 'json' },
    });

    await deleteRuntimeCat(projectRoot, 'temp-cat');

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(catalog.breeds.some((breed) => breed.catId === 'temp-cat'), false);
    assert.equal(catalog.breeds.some((breed) => breed.catId === 'opus'), true);
    assert.ok(catalog.roster?.opus, 'existing v2 metadata must stay intact');
  });
});
