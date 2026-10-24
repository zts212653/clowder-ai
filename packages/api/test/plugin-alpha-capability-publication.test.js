import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { restoreDeclaredSkillPolicy } from '../dist/domains/plugin/declared/declared-static-resources.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';

async function fixture(t, deployment) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-alpha-publication-'));
  let runtime;
  t.after(async () => {
    try {
      await runtime?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const projectRoot = join(root, 'deployment');
  const capabilityProjectRoot = join(root, 'persistent');
  const packageRoot = join(root, 'package');
  const pluginId = 'dev.clowder.alpha-publication';
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Alpha publication fixture',
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        capabilities: [],
        contributions: [
          { type: 'mcp', id: 'native' },
          { type: 'skill', id: 'guide' },
        ],
      },
    ],
    contributions: [
      {
        type: 'mcp',
        id: 'native',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
        actions: [{ method: 'native.read' }],
      },
      { type: 'skill', id: 'guide', path: 'skills/guide' },
    ],
  };
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'skills/guide'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(packageRoot, 'dist/mcp.js'), 'process.exit(0);\n');
  await writeFile(join(packageRoot, 'skills/guide/SKILL.md'), '# Guide\n');
  const stableSkill = join(root, 'formal-runtime', 'guide');
  await mkdir(stableSkill, { recursive: true });
  await writeFile(join(stableSkill, 'SKILL.md'), '# Formal runtime guide\n');
  const skillLink = join(capabilityProjectRoot, '.claude/skills/guide');
  await mkdir(join(skillLink, '..'), { recursive: true });
  await symlink(stableSkill, skillLink, process.platform === 'win32' ? 'junction' : 'dir');
  await writeCapabilitiesConfig(capabilityProjectRoot, {
    version: 2,
    capabilities: [
      {
        id: `plugin:${pluginId}:native`,
        type: 'mcp',
        pluginId,
        source: 'plugin',
        enabled: true,
        blockedCats: ['blocked-cat'],
        mcpServer: { command: process.execPath, args: ['/formal-runtime/mcp.js'], transport: 'stdio' },
      },
      {
        id: 'guide',
        type: 'skill',
        pluginId,
        source: 'plugin',
        enabled: true,
        mountPaths: ['claude'],
        skillsSource: '../formal-runtime',
      },
      { id: 'unrelated', type: 'mcp', source: 'external', enabled: false, mcpServer: { command: 'unrelated' } },
    ],
  });
  const sharedPath = join(capabilityProjectRoot, '.cat-cafe/capabilities.json');
  const original = await readFile(sharedPath, 'utf8');
  let writes = 0;
  const previousDeployment = process.env.CAT_CAFE_DEPLOYMENT_ID;
  process.env.CAT_CAFE_DEPLOYMENT_ID = deployment;
  try {
    runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      capabilityProjectRoot,
      messageStore: {},
      contract: { manifestContractRange: '0.1.0', validateEffectiveGrants, validateManifest },
      mcpConfigIO: {
        readConfig: () => readCapabilitiesConfig(capabilityProjectRoot),
        withLock: (operation) => withCapabilityLock(capabilityProjectRoot, operation),
        writeAndRegenCli: async (config) => {
          writes++;
          await writeCapabilitiesConfig(capabilityProjectRoot, config);
        },
      },
    });
  } finally {
    if (previousDeployment === undefined) delete process.env.CAT_CAFE_DEPLOYMENT_ID;
    else process.env.CAT_CAFE_DEPLOYMENT_ID = previousDeployment;
  }
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const mutate = async (enabled) => {
    const current = (await composition.manager.get(pluginId)).plugin;
    return composition.manager.setEnabled(pluginId, { enabled, expectedRevision: current.lifecycleRevision });
  };
  return {
    runtime,
    composition,
    installed,
    pluginId,
    projectRoot,
    capabilityProjectRoot,
    mutate,
    writes: () => writes,
    unchanged: async () => {
      assert.equal(await readFile(sharedPath, 'utf8'), original, 'shared capability bytes must remain unchanged');
      assert.equal(await readlink(skillLink), stableSkill, 'formal skill mount must remain unchanged');
      assert.equal(writes, 0, 'Alpha must never enter MCP publication/CLI reconciliation');
    },
  };
}

test('Alpha activation, refresh, disable and uninstall leave shared capabilities and skill mounts untouched', async (t) => {
  const f = await fixture(t, 'alpha');
  await f.mutate(true);
  await f.unchanged();
  const launch = await f.runtime.supervisor.resolveNativeMcpLaunch({
    mode: 'plugin_native',
    pluginInstanceId: f.installed.pluginInstanceId,
    contributionId: 'native',
    actionMethods: ['native.read'],
  });
  assert.ok(launch.workingDirectory.startsWith(f.projectRoot), 'Alpha retains its own verified native launch');
  await access(launch.args[0]);
  await f.runtime.supervisor.configRefresh(f.installed.pluginInstanceId);
  await f.unchanged();
  await f.mutate(false);
  await f.unchanged();
  await f.mutate(true);
  await f.unchanged();
  const current = (await f.composition.manager.get(f.pluginId)).plugin;
  await f.composition.manager.uninstall(f.pluginId, { expectedRevision: current.lifecycleRevision });
  await f.unchanged();
});

test('a persistent runtime still publishes its own managed MCP descriptor', async (t) => {
  const f = await fixture(t, 'runtime');
  await f.mutate(true);
  const config = await readCapabilitiesConfig(f.capabilityProjectRoot);
  const mcp = config.capabilities.find((entry) => entry.id === `plugin:${f.pluginId}:native`);
  assert.ok(mcp.mcpServer.workingDir.startsWith(f.projectRoot));
  assert.deepEqual(mcp.blockedCats, ['blocked-cat']);
  assert.equal(f.writes(), 1);
  assert.equal(config.capabilities.find((entry) => entry.id === 'unrelated').enabled, false);
});

test('failed Alpha activation cannot restore policy over the persistent owner configuration', async (t) => {
  const f = await fixture(t, 'alpha');
  await restoreDeclaredSkillPolicy(
    f.pluginId,
    {
      projectRoot: f.capabilityProjectRoot,
      persistCapabilities: false,
    },
    [{ id: 'guide', type: 'skill', pluginId: f.pluginId, source: 'plugin', enabled: false }],
  );
  await f.unchanged();
});
