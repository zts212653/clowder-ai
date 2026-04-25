import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function seedTemplate(projectRoot, mutateTemplate) {
  const templatePath = join(__dirname, '..', '..', '..', 'cat-template.json');
  const template = JSON.parse(await readFile(templatePath, 'utf-8'));
  if (mutateTemplate) mutateTemplate(template);
  await writeFile(join(projectRoot, 'cat-template.json'), `${JSON.stringify(template, null, 2)}\n`, 'utf-8');
}

/**
 * F171: bootstrapCatCatalog() now creates empty catalogs (first-run quest).
 * Populate breeds from the template into the catalog, stamping default
 * accountRef and source values that the old bootstrap used to do.
 */
const BUILTIN_ACCOUNT_IDS = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  dare: 'dare',
  opencode: 'opencode',
};

async function seedCatalogBreeds(projectRoot) {
  const template = JSON.parse(await readFile(join(projectRoot, 'cat-template.json'), 'utf-8'));
  const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
  catalog.breeds = structuredClone(template.breeds || []);
  for (const breed of catalog.breeds) {
    for (const variant of breed.variants || []) {
      if (!variant.accountRef && variant.clientId && BUILTIN_ACCOUNT_IDS[variant.clientId]) {
        variant.accountRef = BUILTIN_ACCOUNT_IDS[variant.clientId];
      }
    }
  }
  if (template.roster) {
    catalog.roster = { ...(catalog.roster || {}), ...template.roster };
  }
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
}

describe('cat account binding', () => {
  it('treats bootstrapped seed cats as inheriting the active bootstrap binding', async () => {
    const { bootstrapCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { resolveBoundAccountRefForCat } = await import('../dist/config/cat-account-binding.js');
    const projectRoot = await mkdtemp(join(tmpdir(), 'cat-account-binding-inherited-'));
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;

    try {
      await seedTemplate(projectRoot);
      bootstrapCatCatalog(projectRoot, join(projectRoot, 'cat-template.json'));
      await seedCatalogBreeds(projectRoot);
      const catConfig = toAllCatConfigs(loadCatConfig(resolveCatCatalogPath(projectRoot))).codex;
      assert.ok(catConfig, 'codex should be present in bootstrapped runtime catalog');
      assert.equal(resolveBoundAccountRefForCat(projectRoot, 'codex', catConfig), 'codex');
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns explicit seed accountRef markers after bootstrap', async () => {
    const { bootstrapCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { resolveBoundAccountRefForCat } = await import('../dist/config/cat-account-binding.js');
    const projectRoot = await mkdtemp(join(tmpdir(), 'cat-account-binding-explicit-'));
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;

    try {
      await seedTemplate(projectRoot, (template) => {
        const codexBreed = template.breeds.find((breed) => breed.catId === 'codex');
        if (!codexBreed) throw new Error('codex breed missing from template');
        codexBreed.variants[0].accountRef = 'codex-pinned';
      });
      bootstrapCatCatalog(projectRoot, join(projectRoot, 'cat-template.json'));
      await seedCatalogBreeds(projectRoot);
      const catConfig = toAllCatConfigs(loadCatConfig(resolveCatCatalogPath(projectRoot))).codex;
      assert.ok(catConfig, 'codex should be present in bootstrapped runtime catalog');
      assert.equal(resolveBoundAccountRefForCat(projectRoot, 'codex', catConfig), 'codex-pinned');
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('backfills legacy accountRef-only seed bindings before suppressing inherited bootstrap refs', async () => {
    const { bootstrapCatCatalog, readCatCatalog, resolveCatCatalogPath } = await import(
      '../dist/config/cat-catalog-store.js'
    );
    const { toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { resolveBoundAccountRefForCat } = await import('../dist/config/cat-account-binding.js');
    const projectRoot = await mkdtemp(join(tmpdir(), 'cat-account-binding-legacy-seed-'));
    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;

    try {
      // Use 'test-spark' (not 'spark') to avoid collision with the global template's
      // existing 'spark' variant catId registered by setup-cat-registry.js.
      await seedTemplate(projectRoot, (template) => {
        const codexBreed = template.breeds.find((breed) => breed.catId === 'codex');
        codexBreed.variants.push({
          id: 'codex-test-spark',
          catId: 'test-spark',
          clientId: 'openai',
          defaultModel: 'gpt-5.4-spark',
          mcpSupport: false,
          cli: { command: 'codex', outputFormat: 'json' },
        });
      });
      process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
      bootstrapCatCatalog(projectRoot, process.env.CAT_TEMPLATE_PATH);
      await seedCatalogBreeds(projectRoot);

      const catalogPath = resolveCatCatalogPath(projectRoot);
      const runtimeCatalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
      const codexBreed = runtimeCatalog.breeds.find((breed) => breed.catId === 'codex');
      const sparkVariant = codexBreed?.variants.find((variant) => variant.catId === 'test-spark');
      if (!codexBreed || !codexBreed.variants[0] || !sparkVariant) {
        throw new Error('codex seed variants missing from bootstrapped runtime catalog');
      }

      codexBreed.variants[0].accountRef = 'codex-sponsor';
      sparkVariant.accountRef = 'codex';
      await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
      await writeFile(catalogPath, `${JSON.stringify(runtimeCatalog, null, 2)}\n`, 'utf-8');

      const migratedCatalog = readCatCatalog(projectRoot);
      const catConfig = toAllCatConfigs(migratedCatalog).codex;
      assert.ok(catConfig, 'codex should still be present after migration');
      assert.equal(resolveBoundAccountRefForCat(projectRoot, 'codex', catConfig), 'codex-sponsor');

      const migratedRaw = JSON.parse(await readFile(catalogPath, 'utf-8'));
      const migratedCodexBreed = migratedRaw.breeds.find((breed) => breed.catId === 'codex');
      const migratedSparkVariant = migratedCodexBreed?.variants.find((variant) => variant.catId === 'test-spark');
      assert.equal(migratedCodexBreed?.variants[0]?.accountRef, 'codex-sponsor');
      assert.equal(migratedSparkVariant?.accountRef, 'codex');
    } finally {
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps untouched seed siblings inherited after bootstrap switches to a new account', async () => {
    const { bootstrapCatCatalog, readCatCatalog, resolveCatCatalogPath } = await import(
      '../dist/config/cat-catalog-store.js'
    );
    const { toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { resolveBoundAccountRefForCat } = await import('../dist/config/cat-account-binding.js');
    const { activateProviderProfile, createProviderProfile } = await import('./helpers/create-test-account.js');
    const projectRoot = await mkdtemp(join(tmpdir(), 'cat-account-binding-sibling-inherited-'));
    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;

    try {
      // Use 'test-spark' (not 'spark') to avoid collision with the global template's
      // existing 'spark' variant catId registered by setup-cat-registry.js.
      await seedTemplate(projectRoot, (template) => {
        const codexBreed = template.breeds.find((breed) => breed.catId === 'codex');
        codexBreed.variants.push({
          id: 'codex-test-spark',
          catId: 'test-spark',
          clientId: 'openai',
          defaultModel: 'gpt-5.4-spark',
          mcpSupport: false,
          cli: { command: 'codex', outputFormat: 'json' },
        });
      });
      process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
      bootstrapCatCatalog(projectRoot, process.env.CAT_TEMPLATE_PATH);
      await seedCatalogBreeds(projectRoot);

      const catalogPath = resolveCatCatalogPath(projectRoot);
      const runtimeCatalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
      const codexBreed = runtimeCatalog.breeds.find((breed) => breed.catId === 'codex');
      const sparkVariant = codexBreed?.variants.find((variant) => variant.catId === 'test-spark');
      if (!codexBreed || !codexBreed.variants[0] || !sparkVariant) {
        throw new Error('codex seed variants missing from bootstrapped runtime catalog');
      }

      codexBreed.variants[0].accountRef = 'codex-sponsor';
      sparkVariant.accountRef = 'codex';
      await writeFile(catalogPath, `${JSON.stringify(runtimeCatalog, null, 2)}\n`, 'utf-8');

      const activatedProfile = await createProviderProfile(projectRoot, {
        provider: 'openai',
        name: 'activated-openai',
        mode: 'api_key',
        authType: 'api_key',
        protocol: 'openai',
        baseUrl: 'https://api.activated.example',
        apiKey: 'sk-activated-openai',
        setActive: false,
      });
      await activateProviderProfile(projectRoot, 'openai', activatedProfile.id);

      const migratedCatalog = readCatCatalog(projectRoot);
      const allCats = toAllCatConfigs(migratedCatalog);
      assert.equal(resolveBoundAccountRefForCat(projectRoot, 'codex', allCats.codex), 'codex-sponsor');
      // Authoritative model: test-spark's explicit 'codex' binding is returned directly
      assert.equal(resolveBoundAccountRefForCat(projectRoot, 'test-spark', allCats['test-spark']), 'codex');
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves seed cat accountRef authoritatively — bootstrap stamps builtin binding', async () => {
    const { bootstrapCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { resolveBoundAccountRefForCat } = await import('../dist/config/cat-account-binding.js');
    const projectRoot = await mkdtemp(join(tmpdir(), 'cat-account-binding-anthropic-seed-'));
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;

    try {
      await seedTemplate(projectRoot);
      bootstrapCatCatalog(projectRoot, join(projectRoot, 'cat-template.json'));
      await seedCatalogBreeds(projectRoot);
      await writeFile(
        join(projectRoot, '.cat-cafe', 'accounts.json'),
        JSON.stringify(
          {
            claude: { authType: 'oauth', models: ['claude-opus-4-6'] },
            'installer-anthropic': {
              authType: 'api_key',
              displayName: 'Installer Anthropic',
              baseUrl: 'https://proxy.example.dev',
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      await writeFile(
        join(projectRoot, '.cat-cafe', 'credentials.json'),
        JSON.stringify(
          {
            'installer-anthropic': { apiKey: 'sk-installer-anthropic' },
          },
          null,
          2,
        ),
        'utf-8',
      );

      const opus = toAllCatConfigs(loadCatConfig(resolveCatCatalogPath(projectRoot))).opus;
      assert.ok(opus, 'opus should be present in bootstrapped runtime catalog');
      // Authoritative model: bootstrap stamps 'claude' as accountRef → returned directly
      assert.equal(resolveBoundAccountRefForCat(projectRoot, 'opus', opus), 'claude');
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
