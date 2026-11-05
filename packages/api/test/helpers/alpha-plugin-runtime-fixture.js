import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest } from '@clowder-ai/plugin-contract';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../../dist/domains/plugin/index.js';

export async function fixture(t, deployment, withRuntimeRoot = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-alpha-publication-')));
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
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, '.git'), 'gitdir: ../persistent/.git/worktrees/deployment\n');
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
  const previousRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
  if (withRuntimeRoot) process.env.CAT_CAFE_RUNTIME_ROOT = projectRoot;
  else delete process.env.CAT_CAFE_RUNTIME_ROOT;
  if (deployment === undefined) delete process.env.CAT_CAFE_DEPLOYMENT_ID;
  else process.env.CAT_CAFE_DEPLOYMENT_ID = deployment;
  try {
    runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      binaryProjectRoot: projectRoot,
      capabilityProjectRoot,
      messageStore: {},
      contract: { manifestContractRange: '0.1.0', validateManifest },
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
    if (previousRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = previousRuntimeRoot;
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
      assert.equal(writes, 0, 'isolated deployment must never enter shared MCP publication/CLI reconciliation');
    },
  };
}
