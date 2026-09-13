// @ts-check
/**
 * Origin↔upstream integration boot smoke.
 *
 * Locks the Hub cold-start composition seam from packages/api/src/index.ts:
 *   1) accountStartupHook (migrate + inspect; unavailable accounts warn, do not abort)
 *   2) first syncAgentRegistry ACP path (createAcpServiceForConfig per member)
 *
 * Production previously ran registry sync before accountStartupHook; that order
 * is inverted so fail-fast store adjudication precedes ACP registration.
 * This test follows that locked order. Full Fastify boot / warmL0 remain out of
 * scope — the seam under test is accountStartupHook → createAcpServiceForConfig.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_TEMPLATE_PATH = join(__dirname, '..', '..', '..', 'cat-template.json');
const API_INDEX_SOURCE = join(__dirname, '..', 'src', 'index.ts');

const { accountStartupHook } = await import('../dist/config/account-startup.js');
const { resetMigrationState, writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');
const { createAcpServiceForConfig } = await import(
  '../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);
const { getAcpConfig, loadCatConfig, toAllCatConfigs, _resetCachedConfig } = await import(
  '../dist/config/cat-config-loader.js'
);

function writeDshFixture() {
  const root = mkdtempSync(join(tmpdir(), 'boot-smoke-dsh-'));
  const binDir = join(root, 'packages', 'examples', 'acp-demo', 'lib');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'bin.js'), '#!/usr/bin/env node\n');
  const mcpClientLib = join(root, 'packages', 'mcp', 'mcp-client', 'lib');
  mkdirSync(mcpClientLib, { recursive: true });
  writeFileSync(
    join(root, 'packages', 'mcp', 'mcp-client', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', type: 'module', main: 'lib/index.js' }),
  );
  writeFileSync(join(mcpClientLib, 'index.js'), 'export default {}\n');
  const configDir = join(root, 'examples', 'acp-agent');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'cordis.yml'), "- id: acp-agent\n  name: '@deepseek-ai/dsh-acp-demo'\n");
  return root;
}

describe('origin↔upstream Hub boot smoke', () => {
  it('locks production composition: accountStartupHook before first syncAgentRegistry', () => {
    const source = readFileSync(API_INDEX_SOURCE, 'utf8');
    const accountHook = source.indexOf('accountStartupHook(findMonorepoRoot(process.cwd()))');
    const firstSync = source.indexOf('await syncAgentRegistry(catRegistry.getAllConfigs())');
    assert.ok(accountHook > 0, 'accountStartupHook call must exist in api index');
    assert.ok(firstSync > 0, 'syncAgentRegistry call must exist in api index');
    assert.ok(
      accountHook < firstSync,
      'accountStartupHook must precede the first syncAgentRegistry (fail-fast before ACP register)',
    );
  });

  /** @type {string} */
  let globalRoot;
  /** @type {string} */
  let projectRoot;
  /** @type {string | undefined} */
  let previousGlobalRoot;
  /** @type {string | undefined} */
  let previousHome;
  /** @type {string | undefined} */
  let previousDshRoot;
  /** @type {string | undefined} */
  let previousDshConfig;
  /** @type {string | undefined} */
  let previousZcodeBin;
  /** @type {string | undefined} */
  let previousZcodeHome;
  /** @type {string | undefined} */
  let previousAnthropic;

  beforeEach(() => {
    globalRoot = mkdtempSync(join(tmpdir(), 'boot-smoke-global-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'boot-smoke-project-'));
    mkdirSync(join(globalRoot, '.cat-cafe'), { recursive: true });
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    copyFileSync(REPO_TEMPLATE_PATH, join(projectRoot, 'cat-template.json'));

    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    previousHome = process.env.HOME;
    previousDshRoot = process.env.CAT_CAFE_DSH_ROOT;
    previousDshConfig = process.env.CAT_CAFE_DSH_ACP_CONFIG;
    previousZcodeBin = process.env.CAT_CAFE_ZCODE_BIN;
    previousZcodeHome = process.env.CAT_CAFE_ZCODE_HOME;
    previousAnthropic = process.env.ANTHROPIC_API_KEY;

    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    process.env.HOME = globalRoot;
    delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
    resetMigrationState();
    _resetCachedConfig();
  });

  afterEach(() => {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDshRoot === undefined) delete process.env.CAT_CAFE_DSH_ROOT;
    else process.env.CAT_CAFE_DSH_ROOT = previousDshRoot;
    if (previousDshConfig === undefined) delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
    else process.env.CAT_CAFE_DSH_ACP_CONFIG = previousDshConfig;
    if (previousZcodeBin === undefined) delete process.env.CAT_CAFE_ZCODE_BIN;
    else process.env.CAT_CAFE_ZCODE_BIN = previousZcodeBin;
    if (previousZcodeHome === undefined) delete process.env.CAT_CAFE_ZCODE_HOME;
    else process.env.CAT_CAFE_ZCODE_HOME = previousZcodeHome;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    resetMigrationState();
    _resetCachedConfig();
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('accountStartupHook + ACP registry sync tolerate healthy and rejected accounts together', async () => {
    // Healthy account (upstream topology store).
    writeCatalogAccount(projectRoot, 'claude', { authType: 'oauth' });
    // Torn credential without metadata → unavailableAccounts, must not abort startup.
    writeFileSync(
      join(globalRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({
        claude: { apiKey: 'sk-healthy-ignored-for-oauth' },
        'torn-boot-account': { apiKey: 'sk-torn' },
      }),
    );
    resetMigrationState();

    const startup = accountStartupHook(projectRoot);
    assert.ok(startup.accountCount >= 1, 'healthy account must load');
    assert.ok(
      startup.unavailableAccounts.some((entry) => entry.accountRef === 'torn-boot-account'),
      `torn account must surface as unavailable, got ${JSON.stringify(startup.unavailableAccounts)}`,
    );

    const dshRoot = writeDshFixture();
    process.env.CAT_CAFE_DSH_ROOT = dshRoot;
    const zcodeBinDir = mkdtempSync(join(tmpdir(), 'boot-smoke-zcode-'));
    const zcodeBin = join(zcodeBinDir, 'zcode.cjs');
    writeFileSync(zcodeBin, '#!/usr/bin/env node\n');
    process.env.CAT_CAFE_ZCODE_BIN = zcodeBin;
    process.env.CAT_CAFE_ZCODE_HOME = join(zcodeBinDir, 'home');
    process.env.ANTHROPIC_API_KEY = 'sk-test-boot-smoke';

    const templatePath = join(projectRoot, 'cat-template.json');
    const all = toAllCatConfigs(loadCatConfig(templatePath));
    const poolRegistry = new Map();
    const warnings = [];
    const log = {
      info() {},
      warn(obj, msg) {
        warnings.push({ obj, msg });
      },
    };

    // Mirror syncAgentRegistry ACP branch: create services for home ACP members.
    /** @type {Record<string, unknown>} */
    const registered = {};
    for (const id of ['grok-build', 'dsh', 'zcode']) {
      const config = all[id];
      assert.ok(config, `${id} must exist in cat-template roster`);
      const acpConfig = getAcpConfig(id, projectRoot);
      assert.ok(acpConfig, `${id} must have acp config`);
      const service = await createAcpServiceForConfig({
        projectRoot,
        profileId: id,
        config,
        effectiveModel: config.defaultModel,
        acpConfig,
        poolRegistry,
        log,
      });
      registered[id] = service;
    }

    // Torn binding after DSH-capable factory must skip, not throw (cross-path).
    const torn = await createAcpServiceForConfig({
      projectRoot,
      profileId: 'boot-torn-dsh',
      config: {
        ...all.dsh,
        id: 'boot-torn-dsh',
        accountRef: 'torn-boot-account',
        clientId: 'anthropic',
        provider: 'anthropic',
      },
      effectiveModel: all.dsh.defaultModel,
      acpConfig: { ...getAcpConfig('dsh', projectRoot), command: 'dsh' },
      poolRegistry,
      log,
    });

    assert.ok(registered['grok-build'], 'grok-build must register on boot path');
    assert.ok(registered.dsh, 'dsh must register when ACP demo fixture is present');
    assert.ok(registered.zcode, 'zcode must register when zcode.bin fixture is present');
    assert.equal(torn, null, 'torn account must skip ACP registration without aborting boot');
    assert.ok(
      warnings.some(
        (entry) =>
          String(entry.msg ?? '').includes('could not be adjudicated') ||
          String(entry.obj?.err?.message ?? entry.obj?.reason ?? '').includes('torn credential'),
      ),
      `expected rejected-account warning during boot sync, got ${JSON.stringify(warnings)}`,
    );

    await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
    rmSync(dshRoot, { recursive: true, force: true });
    rmSync(zcodeBinDir, { recursive: true, force: true });
  });
});
