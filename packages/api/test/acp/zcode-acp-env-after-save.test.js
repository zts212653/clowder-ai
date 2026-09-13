// @ts-check
/**
 * After Hub binds a plain API-key account, generic ACP strips catalog
 * `provider`. ZCode spawn env must still come from acp.command.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import '../helpers/setup-cat-registry.js';
import { createProviderProfile } from '../helpers/create-test-account.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_TEMPLATE_PATH = join(__dirname, '..', '..', '..', '..', 'cat-template.json');
const tempDirs = [];

const { createAcpServiceForConfig } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);
const { getAcpConfig, loadResolvedCatConfig, toAllCatConfigs, _resetCachedConfig } = await import(
  '../../dist/config/cat-config-loader.js'
);

function seedRepoCatalog(projectRoot) {
  const templatePath = join(projectRoot, 'cat-template.json');
  copyFileSync(REPO_TEMPLATE_PATH, templatePath);
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  // Template no longer seeds provider on generic ACP variants (F161). Simulate the
  // legacy/stale state this regression locks down: a catalog variant that still
  // carries provider:zcode before the Hub save clears it.
  const catalog = JSON.parse(readFileSync(templatePath, 'utf-8'));
  const zcodeBreed = catalog.breeds.find((breed) => breed.id === 'zcode');
  assert.ok(zcodeBreed, 'template must contain the zcode breed');
  zcodeBreed.variants[0].provider = 'zcode';
  writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(join(projectRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  return templatePath;
}

function isolateEnv(projectRoot) {
  const prev = {
    CAT_TEMPLATE_PATH: process.env.CAT_TEMPLATE_PATH,
    CAT_CAFE_CONFIG_ROOT: process.env.CAT_CAFE_CONFIG_ROOT,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT,
    CAT_CAFE_ZCODE_BIN: process.env.CAT_CAFE_ZCODE_BIN,
    CAT_CAFE_ZCODE_HOME: process.env.CAT_CAFE_ZCODE_HOME,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ZCODE_API_KEY: process.env.ZCODE_API_KEY,
  };
  process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
  process.env.CAT_CAFE_CONFIG_ROOT = projectRoot;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ZCODE_API_KEY;
  return prev;
}

function restoreEnv(prev) {
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('ZCode env-map after generic ACP save', () => {
  it('keeps ZCode credential injection after PATCH strips provider, and does not map ordinary ACP', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zcode-env-after-save-'));
    tempDirs.push(projectRoot);
    seedRepoCatalog(projectRoot);
    const prev = isolateEnv(projectRoot);
    const poolRegistry = new Map();
    const zcodeBinDir = mkdtempSync(join(tmpdir(), 'zcode-bin-'));
    tempDirs.push(zcodeBinDir);
    const zcodeBin = join(zcodeBinDir, 'zcode.cjs');
    writeFileSync(zcodeBin, '#!/usr/bin/env node\n');
    process.env.CAT_CAFE_ZCODE_BIN = zcodeBin;
    process.env.CAT_CAFE_ZCODE_HOME = join(zcodeBinDir, 'isolated-home');
    _resetCachedConfig();

    try {
      const catalogBefore = JSON.parse(readFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), 'utf-8'));
      const zcodeBefore = catalogBefore.breeds.find((breed) => breed.id === 'zcode')?.variants?.[0];
      assert.equal(zcodeBefore?.provider, 'zcode', 'template catalog starts with harness provider');

      const account = await createProviderProfile(projectRoot, {
        displayName: 'ZCode Plain Key',
        authType: 'api_key',
        protocol: 'anthropic',
        apiKey: 'sk-zcode-plain',
        baseUrl: 'https://api.z.ai/api/anthropic',
        models: ['GLM-5.2'],
      });
      assert.equal(account.envVars, undefined);

      const Fastify = (await import('fastify')).default;
      const { catsRoutes } = await import('../../dist/routes/cats.js');
      const app = Fastify();
      await app.register(catsRoutes);

      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/cats/zcode',
        headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
        body: JSON.stringify({ accountRef: account.id, provider: null }),
      });
      assert.equal(patchRes.statusCode, 200, `zcode patch failed: ${patchRes.body}`);
      const patched = JSON.parse(patchRes.body);
      assert.equal(patched.cat.provider, undefined, 'generic ACP save must not persist provider:zcode');
      assert.equal(patched.cat.accountRef, account.id);

      const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
      const listed = JSON.parse(listRes.body).cats.find((cat) => cat.id === 'zcode');
      assert.equal(listed?.provider, undefined);

      _resetCachedConfig();
      // Resolved read = template + catalog overlay merge; this is the path where a
      // template-seeded provider used to resurrect after the catalog cleared it.
      const zcode = toAllCatConfigs(loadResolvedCatConfig(join(projectRoot, 'cat-template.json'))).zcode;
      const zcodeAcp = getAcpConfig('zcode', projectRoot);
      assert.ok(zcode, 'zcode member must remain after save');
      assert.ok(zcodeAcp, 'zcode acp config must remain after save');
      assert.equal(zcode.provider, undefined);
      assert.equal(zcodeAcp.command, 'zcode');

      const zcodeService = await createAcpServiceForConfig({
        projectRoot,
        profileId: 'zcode',
        config: zcode,
        effectiveModel: zcode.defaultModel,
        acpConfig: zcodeAcp,
        poolRegistry,
        log: { info() {}, warn() {} },
      });
      assert.ok(zcodeService, 'ZCode must still register after provider is stripped');
      const zcodeEnv = JSON.parse(zcodeService.pool.spawnSignature).env;
      assert.equal(zcodeEnv.ANTHROPIC_API_KEY, 'sk-zcode-plain');
      assert.equal(zcodeEnv.ZCODE_API_KEY, 'sk-zcode-plain');
      assert.equal(zcodeEnv.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
        body: JSON.stringify({
          catId: 'plain-acp',
          name: 'Plain ACP',
          displayName: 'Plain ACP',
          avatar: '/avatars/default.png',
          color: { primary: '#111827', secondary: '#e5e7eb' },
          mentionPatterns: ['@plain-acp'],
          roleDescription: 'ordinary generic ACP',
          clientId: 'acp',
          accountRef: account.id,
          defaultModel: 'GLM-5.2',
          provider: 'zcode',
          acp: { command: 'mock-acp', startupArgs: [] },
        }),
      });
      assert.equal(createRes.statusCode, 201, `plain acp create failed: ${createRes.body}`);
      assert.equal(JSON.parse(createRes.body).cat.provider, undefined);

      _resetCachedConfig();
      const plain = toAllCatConfigs(loadResolvedCatConfig(join(projectRoot, 'cat-template.json')))['plain-acp'];
      const plainAcp = getAcpConfig('plain-acp', projectRoot);
      assert.ok(plain, 'ordinary ACP member must persist');
      assert.ok(plainAcp, 'ordinary ACP config must persist');
      const plainService = await createAcpServiceForConfig({
        projectRoot,
        profileId: 'plain-acp',
        config: plain,
        effectiveModel: plain.defaultModel,
        acpConfig: plainAcp,
        poolRegistry,
        log: { info() {}, warn() {} },
      });
      assert.ok(plainService, 'ordinary ACP should still register');
      const plainEnv = JSON.parse(plainService.pool.spawnSignature).env ?? {};
      assert.equal(plainEnv.ANTHROPIC_API_KEY, undefined, 'ordinary ACP must not eat the ZCode env-map');
      assert.equal(plainEnv.ZCODE_API_KEY, undefined);
      await app.close();
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      _resetCachedConfig();
      restoreEnv(prev);
    }
  });
});
