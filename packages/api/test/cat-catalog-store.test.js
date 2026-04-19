import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const { bootstrapCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
const { createRuntimeCat, deleteRuntimeCat, readRuntimeCatCatalog, updateRuntimeCat } = await import(
  '../dist/config/runtime-cat-catalog.js'
);

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
    coCreator: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

function makeF127BootstrapTemplate() {
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
        roleDescription: 'Claude 系主力',
        defaultVariantId: 'opus-default',
        variants: [
          {
            id: 'opus-default',
            provider: 'anthropic',
            defaultModel: 'claude-opus-4-6',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
          {
            id: 'opus-sonnet',
            catId: 'sonnet',
            displayName: '布偶猫',
            mentionPatterns: ['@sonnet'],
            provider: 'anthropic',
            defaultModel: 'claude-sonnet-4',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
        ],
      },
      {
        id: 'maine-coon',
        catId: 'codex',
        name: '缅因猫',
        displayName: '缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
        mentionPatterns: ['@codex', '@缅因猫'],
        roleDescription: 'Codex 系主力',
        defaultVariantId: 'codex-default',
        variants: [
          {
            id: 'codex-default',
            provider: 'openai',
            defaultModel: 'gpt-5.4',
            mcpSupport: true,
            cli: { command: 'codex', outputFormat: 'json' },
          },
          {
            id: 'codex-spark',
            catId: 'spark',
            displayName: '缅因猫',
            mentionPatterns: ['@spark'],
            provider: 'openai',
            defaultModel: 'gpt-5.3-codex-spark',
            mcpSupport: true,
            cli: { command: 'codex', outputFormat: 'json' },
          },
        ],
      },
      {
        id: 'siamese',
        catId: 'gemini',
        name: '暹罗猫',
        displayName: '暹罗猫',
        avatar: '/avatars/gemini.png',
        color: { primary: '#5B9BD5', secondary: '#D6E9F8' },
        mentionPatterns: ['@gemini', '@暹罗猫'],
        roleDescription: 'Gemini 系主力',
        defaultVariantId: 'gemini-default',
        variants: [
          {
            id: 'gemini-default',
            provider: 'google',
            defaultModel: 'gemini-3.1-pro',
            mcpSupport: true,
            cli: { command: 'gemini', outputFormat: 'stream-json' },
          },
        ],
      },
      {
        id: 'dragon-li',
        catId: 'dare',
        name: '狸花猫',
        displayName: '狸花猫',
        avatar: '/avatars/dare.png',
        color: { primary: '#6B7280', secondary: '#E5E7EB' },
        mentionPatterns: ['@dare', '@狸花猫'],
        roleDescription: 'Dare 框架猫',
        defaultVariantId: 'dare-default',
        variants: [
          {
            id: 'dare-default',
            provider: 'dare',
            defaultModel: 'glm-4.7',
            mcpSupport: true,
            cli: { command: 'dare', outputFormat: 'json' },
          },
        ],
      },
      {
        id: 'golden-chinchilla',
        catId: 'opencode',
        name: '金渐层',
        displayName: '金渐层',
        avatar: '/avatars/opencode.png',
        color: { primary: '#C08457', secondary: '#FDE7D3' },
        mentionPatterns: ['@opencode', '@金渐层'],
        roleDescription: 'OpenCode',
        defaultVariantId: 'opencode-default',
        variants: [
          {
            id: 'opencode-default',
            provider: 'opencode',
            defaultModel: 'claude-opus-4-6',
            mcpSupport: true,
            cli: { command: 'opencode', outputFormat: 'json' },
          },
        ],
      },
    ],
    roster: {
      opus: { family: 'ragdoll', roles: ['architect'], lead: true, available: true, evaluation: 'claude' },
      sonnet: { family: 'ragdoll', roles: ['assistant'], lead: false, available: true, evaluation: 'claude-2' },
      codex: { family: 'maine-coon', roles: ['reviewer'], lead: true, available: true, evaluation: 'codex' },
      spark: { family: 'maine-coon', roles: ['coder'], lead: false, available: true, evaluation: 'spark' },
      gemini: { family: 'siamese', roles: ['designer'], lead: true, available: true, evaluation: 'gemini' },
      dare: { family: 'dragon-li', roles: ['coding'], lead: true, available: true, evaluation: 'dare' },
      opencode: { family: 'golden-chinchilla', roles: ['coding'], lead: true, available: true, evaluation: 'opencode' },
    },
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    coCreator: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

function makeSiblingTemplate(seedCatId) {
  const config = validConfig();
  config.breeds[0].catId = seedCatId;
  config.breeds[0].displayName = '影子猫';
  config.breeds[0].mentionPatterns = [`@${seedCatId}`];
  config.roster = {
    [seedCatId]: {
      family: 'ragdoll',
      roles: ['architect'],
      lead: true,
      available: true,
      evaluation: 'shadow',
    },
  };
  return config;
}

describe('cat-catalog-store', () => {
  // Isolate provider profiles to a clean tmpdir so tests don't read from ~/.cat-cafe/
  let savedGlobalRoot;
  const isolationRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-isolation-'));
  before(() => {
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = isolationRoot;
  });
  beforeEach(() => {
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = isolationRoot;
  });
  after(() => {
    if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
  });

  it('bootstraps managed clients with bindings while preserving skipped seed members', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-f127-default-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(makeF127BootstrapTemplate(), null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const runtimeCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));

    // Bootstrap persists template-default bindings for seed cats so activation can
    // later retarget them deterministically, while runtime migrations remain non-
    // backfilling for custom/runtime cats.
    assert.deepEqual(
      runtimeCatalog.breeds.map((breed) => [breed.id, breed.variants.map((variant) => variant.accountRef ?? null)]),
      [
        ['ragdoll', ['claude', 'claude']],
        ['maine-coon', ['codex', 'codex']],
        ['siamese', ['gemini']],
        ['dragon-li', ['dare']],
        ['golden-chinchilla', ['opencode']],
      ],
    );
  });

  it('bootstrap ignores legacy provider-profiles.json and keeps template default bindings', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-f127-installer-'));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(makeF127BootstrapTemplate(), null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const runtimeCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));

    assert.deepEqual(
      runtimeCatalog.breeds.map((breed) => [breed.id, breed.variants.map((variant) => variant.accountRef ?? null)]),
      [
        ['ragdoll', ['claude', 'claude']],
        ['maine-coon', ['codex', 'codex']],
        ['siamese', ['gemini']],
        ['dragon-li', ['dare']],
        ['golden-chinchilla', ['opencode']],
      ],
    );
  });

  it('preserves explicit seed account markers while bootstrapping runtime catalog', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-f127-explicit-seed-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = makeF127BootstrapTemplate();
    const codexBreed = template.breeds.find((breed) => breed.catId === 'codex');
    if (!codexBreed) throw new Error('codex breed missing from template');
    codexBreed.variants[0].accountRef = 'codex-pinned';
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const runtimeCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const runtimeCodexBreed = runtimeCatalog.breeds.find((breed) => breed.catId === 'codex');
    const runtimeCodexVariant = runtimeCodexBreed?.variants[0];

    // F136 Phase 4d: without bootstrap bindings, raw variant passes through.
    // accountRef is preserved as-is on bootstrap.
    assert.equal(runtimeCodexVariant?.accountRef, 'codex-pinned');
  });

  it('bootstraps .cat-cafe/cat-catalog.json from cat-template.json', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    assert.equal(catalogPath, resolveCatCatalogPath(projectRoot));
    assert.ok(existsSync(catalogPath), 'runtime catalog should be created');
    const runtimeCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    // Bootstrap persists the template's default seed binding into the runtime catalog.
    assert.equal(runtimeCatalog.breeds[0]?.variants[0]?.accountRef, 'claude');
  });

  it('bootstraps from legacy cat-config.json before falling back to cat-template.json', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-legacy-bootstrap-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].displayName = '模板布偶猫';
    template.breeds[0].variants[0].defaultModel = 'template-model';
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    const legacyConfig = validConfig();
    legacyConfig.breeds[0].displayName = '旧配置布偶猫';
    legacyConfig.breeds[0].variants[0].defaultModel = 'legacy-model';
    legacyConfig.roster.opus.evaluation = 'legacy-eval';
    writeFileSync(join(projectRoot, 'cat-config.json'), JSON.stringify(legacyConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const runtimeCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));

    assert.equal(runtimeCatalog.breeds[0]?.displayName, '旧配置布偶猫');
    assert.equal(runtimeCatalog.breeds[0]?.variants[0]?.defaultModel, 'legacy-model');
    assert.equal(runtimeCatalog.roster?.opus?.evaluation, 'legacy-eval');
  });

  it('only backfills bootstrap accountRef for seed members when legacy cat-config adds custom variants', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-legacy-custom-variant-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));

    const legacyConfig = validConfig();
    legacyConfig.breeds[0].variants.push({
      id: 'opus-custom',
      catId: 'opus-custom',
      displayName: '自定义布偶猫',
      mentionPatterns: ['@opus-custom'],
      provider: 'openai',
      defaultModel: 'gpt-5.4',
      mcpSupport: true,
      cli: { command: 'codex', outputFormat: 'json' },
    });
    writeFileSync(join(projectRoot, 'cat-config.json'), JSON.stringify(legacyConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const runtimeCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const legacyBreed = runtimeCatalog.breeds.find((breed) => breed.catId === 'opus');
    const seedVariant = legacyBreed?.variants.find((variant) => variant.id === 'opus-default');
    const customVariant = legacyBreed?.variants.find((variant) => variant.id === 'opus-custom');

    assert.equal(seedVariant?.accountRef, 'claude');
    assert.equal(customVariant?.accountRef, undefined);
  });

  it('keeps existing .cat-cafe/cat-catalog.json runtime edits and leaves unbound variants alone', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));

    const runtimeConfig = validConfig();
    runtimeConfig.breeds[0].displayName = '运行时布偶猫';
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(runtimeConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const hydrated = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    assert.equal(hydrated.breeds[0]?.displayName, '运行时布偶猫');
    // clowder-ai#340: migration does NOT backfill accountRef — unbound variants stay unbound
    assert.equal(hydrated.breeds[0]?.variants[0]?.accountRef, undefined);
  });

  it('keeps existing custom runtime cats unbound during catalog migration', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-custom-runtime-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));

    const runtimeConfig = validConfig();
    runtimeConfig.breeds.push({
      id: 'custom-openai',
      catId: 'custom-openai',
      name: '自定义猫',
      displayName: '自定义猫',
      avatar: '/avatars/custom.png',
      color: { primary: '#22c55e', secondary: '#dcfce7' },
      mentionPatterns: ['@custom-openai'],
      roleDescription: '自定义运行时猫',
      defaultVariantId: 'custom-openai-default',
      variants: [
        {
          id: 'custom-openai-default',
          provider: 'openai',
          defaultModel: 'gpt-5.4-mini',
          mcpSupport: false,
          cli: { command: 'codex', outputFormat: 'json' },
        },
      ],
    });
    runtimeConfig.roster['custom-openai'] = {
      family: 'custom-openai',
      roles: ['assistant'],
      lead: false,
      available: true,
      evaluation: 'runtime custom',
    };

    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(runtimeConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const hydrated = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const customBreed = hydrated.breeds.find((breed) => breed.catId === 'custom-openai');
    assert.ok(customBreed, 'custom runtime breed should be preserved');
    assert.equal(customBreed?.variants[0]?.accountRef, undefined);
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
      clientId: 'openai',
      defaultModel: 'gpt-5.4-mini',
      mcpSupport: false,
      cli: { command: 'codex', outputFormat: 'json' },
    });

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(catalog.version, 2);
    assert.equal(catalog.coCreator?.name, 'Co-worker');
    assert.equal(catalog.reviewPolicy?.preferLead, true);
    assert.ok(catalog.roster?.opus, 'existing roster must be preserved');
    assert.deepEqual(catalog.roster?.['spark-lite'], {
      family: 'spark-lite',
      roles: ['assistant'],
      lead: false,
      available: true,
      evaluation: '火花猫 runtime member',
    });
    const created = catalog.breeds.find((breed) => breed.catId === 'spark-lite');
    assert.ok(created, 'spark-lite breed should be created');
    assert.equal(created.displayName, '火花猫');
    assert.deepEqual(created.mentionPatterns, ['@spark-lite', '@火花猫']);
    assert.equal(created.variants[0]?.clientId, 'openai');
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
    assert.equal(catalog.coCreator?.mentionPatterns[0], '@co-worker');
  });

  it('keeps sessionChain updates scoped to non-default variants', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].features = { sessionChain: true };
    template.breeds[0].variants.push({
      id: 'opus-sonnet',
      catId: 'opus-sonnet',
      provider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    await updateRuntimeCat(projectRoot, 'opus-sonnet', { sessionChain: false });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const breed = catalog.breeds.find((item) => item.id === 'ragdoll');
    assert.ok(breed, 'ragdoll breed should still exist');
    assert.equal(breed.features?.sessionChain, true);
    const sonnetVariant = breed.variants.find((variant) => variant.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant should still exist');
    assert.equal(sonnetVariant.sessionChain, false);
    const defaultVariant = breed.variants.find((variant) => variant.id === 'opus-default');
    assert.ok(defaultVariant, 'opus-default variant should still exist');
    assert.equal(defaultVariant.sessionChain, undefined);
  });

  it('keeps roleDescription updates scoped to non-default variants', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].variants.push({
      id: 'opus-sonnet',
      catId: 'opus-sonnet',
      provider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    await updateRuntimeCat(projectRoot, 'opus-sonnet', { roleDescription: '副手架构师' });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const breed = catalog.breeds.find((item) => item.id === 'ragdoll');
    assert.ok(breed, 'ragdoll breed should still exist');
    assert.equal(breed.roleDescription, '主架构师');
    const sonnetVariant = breed.variants.find((variant) => variant.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant should still exist');
    assert.equal(sonnetVariant.roleDescription, '副手架构师');
    const defaultVariant = breed.variants.find((variant) => variant.id === 'opus-default');
    assert.ok(defaultVariant, 'opus-default variant should still exist');
    assert.equal(defaultVariant.roleDescription, undefined);
  });

  it('keeps roleDescription updates scoped to the default variant', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].variants.push({
      id: 'opus-sonnet',
      catId: 'opus-sonnet',
      provider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    await updateRuntimeCat(projectRoot, 'opus', { roleDescription: '默认成员专属职责' });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const breed = catalog.breeds.find((item) => item.id === 'ragdoll');
    assert.ok(breed, 'ragdoll breed should still exist');
    assert.equal(breed.roleDescription, '主架构师');
    const defaultVariant = breed.variants.find((variant) => variant.id === 'opus-default');
    assert.ok(defaultVariant, 'opus-default variant should still exist');
    assert.equal(defaultVariant.roleDescription, '默认成员专属职责');
    const sonnetVariant = breed.variants.find((variant) => variant.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant should still exist');
    assert.equal(sonnetVariant.roleDescription, undefined);
  });

  it('keeps sessionChain updates scoped to the default variant', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].features = { sessionChain: true };
    template.breeds[0].variants.push({
      id: 'opus-sonnet',
      catId: 'opus-sonnet',
      provider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    await updateRuntimeCat(projectRoot, 'opus', { sessionChain: false });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const breed = catalog.breeds.find((item) => item.id === 'ragdoll');
    assert.ok(breed, 'ragdoll breed should still exist');
    assert.equal(breed.features?.sessionChain, true);
    const defaultVariant = breed.variants.find((variant) => variant.id === 'opus-default');
    assert.ok(defaultVariant, 'opus-default variant should still exist');
    assert.equal(defaultVariant.sessionChain, false);
    const sonnetVariant = breed.variants.find((variant) => variant.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant should still exist');
    assert.equal(sonnetVariant.sessionChain, undefined);
  });

  it('does not overwrite runtime catalog when validation fails', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    // Trigger eager migration (F136 Phase 4d backfills accountRef on first read)
    readRuntimeCatCatalog(projectRoot);
    const catalogPath = resolveCatCatalogPath(projectRoot);
    const beforeRaw = readFileSync(catalogPath, 'utf-8');

    assert.throws(() => {
      updateRuntimeCat(projectRoot, 'opus', { defaultModel: '' });
    }, /Invalid cat config/i);

    const afterRaw = readFileSync(catalogPath, 'utf-8');
    assert.equal(afterRaw, beforeRaw, 'failed update must not corrupt persisted runtime catalog');
  });

  it('rejects runtime members that reuse an alias from another cat', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    // Trigger eager migration (F136 Phase 4d backfills accountRef on first read)
    readRuntimeCatCatalog(projectRoot);
    const catalogPath = resolveCatCatalogPath(projectRoot);
    const beforeRaw = readFileSync(catalogPath, 'utf-8');

    assert.throws(() => {
      createRuntimeCat(projectRoot, {
        catId: 'spark-lite',
        breedId: 'spark-lite',
        name: '火花猫',
        displayName: '火花猫',
        avatar: '/avatars/spark.png',
        color: { primary: '#f97316', secondary: '#fed7aa' },
        mentionPatterns: ['@opus', '@spark-lite'],
        roleDescription: '快速执行',
        clientId: 'openai',
        defaultModel: 'gpt-5.4',
        mcpSupport: false,
        cli: { command: 'codex', outputFormat: 'json' },
      });
    }, /mention alias "@opus" is already used by cat "opus"/i);

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
      clientId: 'dare',
      defaultModel: 'dare-1',
      mcpSupport: false,
      cli: { command: 'dare', outputFormat: 'json' },
    });

    await deleteRuntimeCat(projectRoot, 'temp-cat');

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'temp-cat'),
      false,
    );
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'opus'),
      true,
    );
    assert.ok(catalog.roster?.opus, 'existing v2 metadata must stay intact');
  });

  it('blocks seed deletion even when CAT_TEMPLATE_PATH points to an unreadable in-project file', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-stale-template-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'missing-template.json');
    try {
      assert.throws(() => deleteRuntimeCat(projectRoot, 'opus'), /cannot delete seed cat/i);
    } finally {
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
    }

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'opus'),
      true,
    );
  });

  it('ignores sibling CAT_TEMPLATE_PATH prefixes when bootstrapping a runtime catalog', async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-boundary-'));
    const projectRoot = join(parentRoot, 'clowder-ai');
    const siblingRoot = join(parentRoot, 'clowder-ai-old');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });

    const templatePath = join(projectRoot, 'cat-template.json');
    const siblingTemplatePath = join(siblingRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeFileSync(siblingTemplatePath, JSON.stringify(makeSiblingTemplate('shadow-seed'), null, 2));

    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = siblingTemplatePath;
    try {
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
        clientId: 'dare',
        defaultModel: 'dare-1',
        mcpSupport: false,
        cli: { command: 'dare', outputFormat: 'json' },
      });
    } finally {
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
    }

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'opus'),
      true,
      'runtime bootstrap should use the in-project template',
    );
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'shadow-seed'),
      false,
      'sibling template must not seed this project',
    );
  });

  it('does not treat sibling-template seeds as local seeds during delete checks', async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-delete-boundary-'));
    const projectRoot = join(parentRoot, 'clowder-ai');
    const siblingRoot = join(parentRoot, 'clowder-ai-old');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });

    const templatePath = join(projectRoot, 'cat-template.json');
    const siblingTemplatePath = join(siblingRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeFileSync(siblingTemplatePath, JSON.stringify(makeSiblingTemplate('shadow-seed'), null, 2));
    bootstrapCatCatalog(projectRoot, templatePath);

    await createRuntimeCat(projectRoot, {
      catId: 'shadow-seed',
      breedId: 'shadow-seed',
      name: '影子临时猫',
      displayName: '影子临时猫',
      avatar: '/avatars/shadow.png',
      color: { primary: '#334155', secondary: '#cbd5f5' },
      mentionPatterns: ['@shadow-seed'],
      roleDescription: '用于路径边界验证',
      clientId: 'dare',
      defaultModel: 'dare-1',
      mcpSupport: false,
      cli: { command: 'dare', outputFormat: 'json' },
    });

    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = siblingTemplatePath;
    try {
      await deleteRuntimeCat(projectRoot, 'shadow-seed');
    } finally {
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
    }

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'shadow-seed'),
      false,
      'runtime cat matching a sibling seed id should still be deletable',
    );
  });

  // clowder-ai#340: removed api_key bootstrap model fallback test — filterBootstrapCatalog + bootstrapBindings deleted
});
