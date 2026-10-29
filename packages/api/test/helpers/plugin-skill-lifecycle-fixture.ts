import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../../src/config/capabilities/capability-orchestrator.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../../src/domains/plugin/runtime-composition.js';

/** Real Host lifecycle and static plugin resources, with private temporary data and no Redis. */
export async function pluginSkillLifecycleFixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-1727-journey-'));
  const packageRoot = join(root, 'package');
  const pluginId = 'fixture.skill-lifecycle';
  await mkdir(join(packageRoot, 'skills/guide'), { recursive: true });
  await writeFile(join(packageRoot, 'skills/guide/SKILL.md'), '# Fixture plugin guide\n');
  await writeFile(
    join(packageRoot, 'manifest.json'),
    JSON.stringify({
      pluginId,
      name: '插件生命周期验收',
      version: '1.0.0',
      contractVersion: '0.1.0',
      description: '隔离数据上的真实插件管理流程：旧技能迁移、冲突处理、重启和卸载重装。',
      features: [
        {
          id: 'guide',
          name: 'Guide',
          resources: [],
          capabilities: [],
          contributions: [{ type: 'skill', id: 'guide' }],
        },
      ],
      contributions: [{ type: 'skill', id: 'guide', path: 'skills/guide' }],
      steps: Array.from({ length: 30 }, (_, i) => ({
        text: `验收说明 ${i + 1}：操作区应始终可到达，技能冲突不应让整个插件启动失败。`,
      })),
    }),
  );
  await writeCapabilitiesConfig(root, {
    version: 2,
    capabilities: [],
    defaultMountRules: [
      { name: 'claude', path: '.claude/skills', enabled: true },
      { name: 'codex', path: '.codex/skills', enabled: true },
      { name: 'gemini', path: '.gemini/skills', enabled: false },
      { name: 'kimi', path: '.kimi/skills', enabled: true },
    ],
  });
  await mkdir(join(root, '.claude/skills'), { recursive: true });
  await symlink('../../cat-cafe-skills/guide', join(root, '.claude/skills/guide'));
  await mkdir(join(root, '.codex/skills/guide'), { recursive: true });
  await writeFile(join(root, '.codex/skills/guide/user.md'), 'User-owned content must survive.');
  // This fixture owns its own publication root; never inherit the live deployment authority.
  const prior = { deployment: process.env.CAT_CAFE_DEPLOYMENT_ID, runtime: process.env.CAT_CAFE_RUNTIME_ROOT };
  process.env.CAT_CAFE_DEPLOYMENT_ID = 'runtime';
  process.env.CAT_CAFE_RUNTIME_ROOT = root;
  let runtime;
  try {
    runtime = createDormantPluginRuntimeComposition({
      projectRoot: root,
      binaryProjectRoot: root,
      capabilityProjectRoot: root,
      messageStore: {} as never,
      mcpConfigIO: {
        readConfig: () => readCapabilitiesConfig(root),
        withLock: (operation) => withCapabilityLock(root, operation),
        writeAndRegenCli: (config) => writeCapabilitiesConfig(root, config),
      },
    });
  } finally {
    if (prior.deployment === undefined) delete process.env.CAT_CAFE_DEPLOYMENT_ID;
    else process.env.CAT_CAFE_DEPLOYMENT_ID = prior.deployment;
    if (prior.runtime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = prior.runtime;
  }
  const { manager } = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const install = () => manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  try {
    await install();
  } catch (error) {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    pluginId,
    packageRoot,
    runtime,
    manager,
    install,
    close: async () => {
      await runtime.shutdown('test_complete');
      await rm(root, { recursive: true, force: true });
    },
  };
}
