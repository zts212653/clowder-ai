// @ts-check

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_TEMPLATE_PATH = join(__dirname, '..', '..', '..', '..', 'cat-template.json');

const { createAcpServiceForConfig } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);
const { resolveAcpMcpServers } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js'
);
const { getAcpConfig, loadCatConfig, toAllCatConfigs, _resetCachedConfig } = await import(
  '../../dist/config/cat-config-loader.js'
);
const { dshOmitsAcpSessionMcp } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/dsh-acp-bootstrap.js'
);
const { resolveZcodeAcpAdapterPath, zcodeOmitsAcpSessionMcp } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/zcode-acp-bootstrap.js'
);

const SLIM_MCP = [
  'cat-cafe-memory',
  'cat-cafe-collab',
  'cat-cafe-signals',
  'zai-mcp-server',
  'zread',
  'web-search-prime',
  'web-reader',
];

function isolateTemplate() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'harness-member-'));
  const templatePath = join(projectRoot, 'cat-template.json');
  copyFileSync(REPO_TEMPLATE_PATH, templatePath);
  return { projectRoot, templatePath };
}

function writeDshFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fixture-'));
  const binDir = join(root, 'packages', 'examples', 'acp-demo', 'lib');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'bin.js');
  writeFileSync(bin, '#!/usr/bin/env node\n');
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
  return { root, bin, configDir };
}

function withDshRoot(root, fn) {
  const prevRoot = process.env.CAT_CAFE_DSH_ROOT;
  const prevConfig = process.env.CAT_CAFE_DSH_ACP_CONFIG;
  process.env.CAT_CAFE_DSH_ROOT = root;
  delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
  return fn().finally(() => {
    if (prevRoot === undefined) delete process.env.CAT_CAFE_DSH_ROOT;
    else process.env.CAT_CAFE_DSH_ROOT = prevRoot;
    if (prevConfig === undefined) delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
    else process.env.CAT_CAFE_DSH_ACP_CONFIG = prevConfig;
  });
}

describe('Grok Build and DeepSeek Harness member assembly', () => {
  it('resolves Grok Build to ACP stdio and DSH to dsh-acp-demo with family MCP in --config', async () => {
    const { projectRoot, templatePath } = isolateTemplate();
    const fixture = writeDshFixture();
    const poolRegistry = new Map();
    _resetCachedConfig();
    await withDshRoot(fixture.root, async () => {
      try {
        const all = toAllCatConfigs(loadCatConfig(templatePath));
        const grok = all['grok-build'];
        const dsh = all.dsh;
        const deepseek = all.deepseek;
        const zcode = all.zcode;
        const glm = all.glm;
        assert.ok(grok, 'grok-build must exist in the template roster');
        assert.ok(dsh, 'dsh must exist in the template roster');
        assert.ok(deepseek, 'OpenCode 渊渊 must stay in the roster');
        assert.ok(zcode, 'zcode must exist in the template roster');
        assert.ok(glm, 'OpenCode 橘猫 must stay in the roster');
        assert.equal(grok.clientId, 'acp');
        assert.equal(dsh.clientId, 'acp');
        assert.equal(zcode.clientId, 'acp');
        assert.equal(deepseek.clientId, 'opencode');
        assert.equal(glm.clientId, 'opencode');
        assert.notEqual(dsh.id, deepseek.id);
        assert.notEqual(zcode.id, glm.id);

        const grokAcp = getAcpConfig('grok-build', projectRoot);
        const dshAcp = getAcpConfig('dsh', projectRoot);
        const zcodeAcp = getAcpConfig('zcode', projectRoot);
        assert.ok(grokAcp, 'grok-build must have an acp section');
        assert.ok(dshAcp, 'dsh must have an acp section');
        assert.ok(zcodeAcp, 'zcode must have an acp section');
        assert.equal(grokAcp.command, 'grok');
        assert.equal(dshAcp.command, 'dsh');
        assert.equal(zcodeAcp.command, 'zcode');
        assert.deepEqual(grokAcp.mcpWhitelist, SLIM_MCP);
        assert.deepEqual(dshAcp.mcpWhitelist, SLIM_MCP);
        assert.equal(dshOmitsAcpSessionMcp(dshAcp.command), true);
        assert.equal(dshOmitsAcpSessionMcp(grokAcp.command), false);
        assert.equal(zcodeOmitsAcpSessionMcp(zcodeAcp.command), true);
        assert.equal(zcode.mcpSupport, false);
        assert.deepEqual(zcodeAcp.mcpWhitelist ?? [], []);

        const zcodeBinDir = mkdtempSync(join(tmpdir(), 'zcode-bin-'));
        const zcodeBin = join(zcodeBinDir, 'zcode.cjs');
        writeFileSync(zcodeBin, '#!/usr/bin/env node\n');
        const zcodeHome = join(zcodeBinDir, 'isolated-home');
        const prevZcodeBin = process.env.CAT_CAFE_ZCODE_BIN;
        const prevAnthropic = process.env.ANTHROPIC_API_KEY;
        const prevZcodeHome = process.env.CAT_CAFE_ZCODE_HOME;
        process.env.CAT_CAFE_ZCODE_BIN = zcodeBin;
        process.env.ANTHROPIC_API_KEY = 'sk-test-zcode-assembly';
        process.env.CAT_CAFE_ZCODE_HOME = zcodeHome;
        const grokService = await createAcpServiceForConfig({
          projectRoot,
          profileId: 'grok-build',
          config: grok,
          effectiveModel: grok.defaultModel,
          acpConfig: grokAcp,
          poolRegistry,
          log: { info() {}, warn() {} },
        });
        const dshService = await createAcpServiceForConfig({
          projectRoot,
          profileId: 'dsh',
          config: dsh,
          effectiveModel: dsh.defaultModel,
          acpConfig: dshAcp,
          poolRegistry,
          log: { info() {}, warn() {} },
        });
        const zcodeService = await createAcpServiceForConfig({
          projectRoot,
          profileId: 'zcode',
          config: zcode,
          effectiveModel: zcode.defaultModel,
          acpConfig: zcodeAcp,
          poolRegistry,
          log: { info() {}, warn() {} },
        });
        if (prevZcodeBin === undefined) delete process.env.CAT_CAFE_ZCODE_BIN;
        else process.env.CAT_CAFE_ZCODE_BIN = prevZcodeBin;
        if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropic;
        if (prevZcodeHome === undefined) delete process.env.CAT_CAFE_ZCODE_HOME;
        else process.env.CAT_CAFE_ZCODE_HOME = prevZcodeHome;
        rmSync(zcodeBinDir, { recursive: true, force: true });

        assert.ok(grokService, 'Grok Build AgentService must not be skipped');
        assert.ok(dshService, 'DeepSeek Harness AgentService must not be skipped when ACP demo is present');
        assert.ok(zcodeService, 'ZCode AgentService must not be skipped when zcode.cjs is present');
        assert.equal(grokService.catId, 'grok-build');
        assert.equal(dshService.catId, 'dsh');
        assert.equal(zcodeService.catId, 'zcode');

        const grokSpawn = JSON.parse(grokService.pool.spawnSignature);
        const dshSpawn = JSON.parse(dshService.pool.spawnSignature);
        const zcodeSpawn = JSON.parse(zcodeService.pool.spawnSignature);
        assert.notEqual(zcodeSpawn.cmd, 'zcode', 'must not send ACP frames to zcode app-server');
        assert.equal(zcodeSpawn.cmd, process.execPath);
        assert.equal(zcodeSpawn.args[0], resolveZcodeAcpAdapterPath());
        assert.equal(grokSpawn.cmd, 'grok');
        assert.ok(
          grokSpawn.args.includes('agent') && grokSpawn.args.includes('stdio'),
          `Grok spawn args must start ACP stdio, got ${JSON.stringify(grokSpawn.args)}`,
        );
        assert.notEqual(dshSpawn.cmd, 'dsh', 'must not speak ACP to the headless dsh CLI');
        assert.equal(dshSpawn.cmd, process.execPath);
        assert.equal(dshSpawn.args[0], fixture.bin);
        assert.equal(
          dshSpawn.cwd,
          join(fixture.root, 'examples', 'acp-agent'),
          'DSH ACP must spawn from the harness composition dir',
        );
        const configIdx = dshSpawn.args.indexOf('--config');
        assert.ok(configIdx >= 0, `DSH spawn must pass --config, got ${JSON.stringify(dshSpawn.args)}`);
        const overlayPath = dshSpawn.args[configIdx + 1];
        assert.equal(dirname(overlayPath), fixture.configDir);
        assert.match(basename(overlayPath), /^cat-cafe-dsh-acp\.[a-f0-9]{64}\.cordis\.yml$/);
        assert.notEqual(
          dshSpawn.args[configIdx + 1],
          join(fixture.root, 'examples', 'acp-agent', 'cordis.yml'),
          'Hub argv must be the sibling overlay, not official-only cordis.yml',
        );
        const overlayYaml = readFileSync(overlayPath, 'utf-8');
        assert.match(overlayYaml, /serverName: 'cat-cafe-memory'/);
        assert.match(overlayYaml, /serverName: 'cat-cafe-collab'/);
        assert.match(overlayYaml, /serverName: 'cat-cafe-signals'/);
        assert.match(overlayYaml, /transport: stdio/);
        assert.match(overlayYaml, /CAT_CAFE_API_URL:/);
        assert.match(overlayYaml, /CAT_CAFE_CREDENTIAL_FILE: !!js process\.env\.CAT_CAFE_CREDENTIAL_FILE/);
        assert.match(overlayYaml, /failOnStartupError: true/);
        assert.doesNotMatch(overlayYaml, /serverName: 'cat-cafe-limb'/);
        assert.doesNotMatch(overlayYaml, /serverName: 'cat-cafe-audio'/);
        assert.doesNotMatch(overlayYaml, /serverName: 'cat-cafe-finance'/);
        assert.match(overlayYaml, /name: '\.\.\/\.\.\/packages\/mcp\/mcp-client\/lib\/index\.js'/);
        assert.ok(overlayYaml.includes('mcp-client'), 'plugin name must be a path containing mcp-client');
        assert.doesNotMatch(overlayYaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
      } finally {
        await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
        _resetCachedConfig();
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  });

  it('skips DSH registration when the official ACP demo is missing', async () => {
    const { projectRoot, templatePath } = isolateTemplate();
    const poolRegistry = new Map();
    const prevRoot = process.env.CAT_CAFE_DSH_ROOT;
    const prevConfig = process.env.CAT_CAFE_DSH_ACP_CONFIG;
    const prevPath = process.env.PATH;
    delete process.env.CAT_CAFE_DSH_ROOT;
    delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
    process.env.PATH = '/nonexistent';
    _resetCachedConfig();
    try {
      const all = toAllCatConfigs(loadCatConfig(templatePath));
      const dshAcp = getAcpConfig('dsh', projectRoot);
      assert.ok(dshAcp);
      const warnings = [];
      const dshService = await createAcpServiceForConfig({
        projectRoot,
        profileId: 'dsh',
        config: all.dsh,
        effectiveModel: all.dsh.defaultModel,
        acpConfig: dshAcp,
        poolRegistry,
        log: {
          info() {},
          warn(_payload, message) {
            warnings.push(String(message ?? _payload));
          },
        },
      });
      assert.equal(dshService, null, 'missing dsh-acp-demo must skip, not spawn bare dsh');
      assert.ok(
        warnings.some((message) => message.includes('dsh-acp-demo') || message.includes('ACP stdio')),
        `skip warning should mention the ACP demo, got ${JSON.stringify(warnings)}`,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.CAT_CAFE_DSH_ROOT;
      else process.env.CAT_CAFE_DSH_ROOT = prevRoot;
      if (prevConfig === undefined) delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
      else process.env.CAT_CAFE_DSH_ACP_CONFIG = prevConfig;
      process.env.PATH = prevPath;
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      _resetCachedConfig();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves the slim cat-cafe MCP whitelist through the shipped ACP resolver', async () => {
    const { projectRoot } = isolateTemplate();
    try {
      const grokAcp = getAcpConfig('grok-build', projectRoot);
      const dshAcp = getAcpConfig('dsh', projectRoot);
      assert.ok(grokAcp && dshAcp);
      const grokServers = await resolveAcpMcpServers(projectRoot, grokAcp.mcpWhitelist ?? [], undefined, {
        mcpSupport: true,
        catId: 'grok-build',
      });
      const dshServers = await resolveAcpMcpServers(projectRoot, dshAcp.mcpWhitelist ?? [], undefined, {
        mcpSupport: true,
        catId: 'dsh',
      });
      const grokNames = grokServers.map((server) => server.name);
      const dshNames = dshServers.map((server) => server.name);
      assert.ok(
        grokNames.some((name) => name === 'cat-cafe' || name.startsWith('cat-cafe')),
        `Grok Build MCP resolve must include family servers, got ${grokNames.join(',')}`,
      );
      assert.ok(
        dshNames.some((name) => name === 'cat-cafe' || name.startsWith('cat-cafe')),
        `DeepSeek Harness MCP resolve must include family servers, got ${dshNames.join(',')}`,
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('upgrades a persisted catalog pinning the pre-zai slim whitelist, for both harness members', () => {
    const { projectRoot, templatePath } = isolateTemplate();
    try {
      const template = JSON.parse(readFileSync(templatePath, 'utf-8'));
      const LEGACY_PIN = ['cat-cafe-memory', 'cat-cafe-collab', 'cat-cafe-signals'];
      // Both members still pin the exact pre-zai shipped default.
      const breeds = ['grok-build', 'dsh'].map((breedId) => {
        const breed = structuredClone(template.breeds.find((candidate) => candidate.id === breedId));
        breed.variants[0].acp.mcpWhitelist = [...LEGACY_PIN];
        return breed;
      });
      const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
      mkdirSync(dirname(catalogPath), { recursive: true });
      writeFileSync(catalogPath, JSON.stringify({ version: template.version, breeds }));

      // getAcpConfig resolves template + catalog from projectRoot and runs the
      // read-time migration (with atomic write-back) on the catalog.
      for (const catId of ['grok-build', 'dsh']) {
        assert.deepEqual(
          getAcpConfig(catId, projectRoot)?.mcpWhitelist,
          SLIM_MCP,
          `${catId}: legacy default pin upgrades to the shipped 7`,
        );
      }

      // Migration persists to disk (atomic write-back) and is idempotent.
      const persisted = JSON.parse(readFileSync(catalogPath, 'utf-8'));
      for (const breedId of ['grok-build', 'dsh']) {
        const persistedBreed = persisted.breeds.find((breed) => breed.id === breedId);
        assert.deepEqual(
          persistedBreed.variants[0].acp.mcpWhitelist,
          SLIM_MCP,
          `${breedId}: upgraded whitelist written back to the catalog`,
        );
        assert.deepEqual(
          getAcpConfig(breedId, projectRoot)?.mcpWhitelist,
          SLIM_MCP,
          `${breedId}: reload from the upgraded catalog stays at the shipped 7`,
        );
      }
    } finally {
      _resetCachedConfig();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('leaves customized whitelists untouched by the pre-zai pin migration', () => {
    const { projectRoot, templatePath } = isolateTemplate();
    try {
      const template = JSON.parse(readFileSync(templatePath, 'utf-8'));
      // Both members carry user-customized lists that differ from the legacy
      // default pin in content and length — the migration must not touch them.
      const customizations = {
        'grok-build': ['cat-cafe-memory', 'zread'],
        dsh: ['cat-cafe-memory'],
      };
      const breeds = ['grok-build', 'dsh'].map((breedId) => {
        const breed = structuredClone(template.breeds.find((candidate) => candidate.id === breedId));
        breed.variants[0].acp.mcpWhitelist = [...customizations[breedId]];
        return breed;
      });
      const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
      mkdirSync(dirname(catalogPath), { recursive: true });
      writeFileSync(catalogPath, JSON.stringify({ version: template.version, breeds }));

      for (const [catId, expected] of Object.entries(customizations)) {
        assert.deepEqual(
          getAcpConfig(catId, projectRoot)?.mcpWhitelist,
          expected,
          `${catId}: customized whitelist is the user decision and must not be touched`,
        );
      }
      const persisted = JSON.parse(readFileSync(catalogPath, 'utf-8'));
      for (const [breedId, expected] of Object.entries(customizations)) {
        const persistedBreed = persisted.breeds.find((breed) => breed.id === breedId);
        assert.deepEqual(persistedBreed.variants[0].acp.mcpWhitelist, expected);
      }
    } finally {
      _resetCachedConfig();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
