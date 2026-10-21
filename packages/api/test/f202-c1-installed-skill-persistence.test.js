import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function createRuntime(projectRoot, options = {}) {
  return createDormantPluginRuntimeComposition({
    projectRoot,
    ...options,
    messageStore: new MessageStore(),
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
}

async function installAndEnableFixture(options) {
  const projectRoot = await tempRoot('cat-cafe-f202-persistent-skill-project-');
  const packageRoot = await tempRoot('cat-cafe-f202-persistent-skill-package-');
  const manifest = {
    pluginId: 'dev.clowder.persistent-skill-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Persistent Skill Fixture',
    contributions: [{ type: 'skill', id: 'declared-skill-id', path: 'skills/persistent-skill' }],
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'skill', id: 'declared-skill-id' }],
        capabilities: [],
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'skills/persistent-skill'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(packageRoot, 'dist/plugin.js'),
    'export default { create() { return { start() { return { actions: {}, stop() {} }; } }; } };\n',
    'utf8',
  );
  await writeFile(join(packageRoot, 'skills/persistent-skill/SKILL.md'), '# Persistent Skill\n', 'utf8');

  const runtime = createRuntime(projectRoot, typeof options === 'function' ? options(projectRoot) : options);
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  return { composition, installed, packageRoot, projectRoot, runtime };
}

function installedSkill(config, pluginId) {
  return config?.capabilities.find(
    (capability) =>
      capability.type === 'skill' && capability.id === 'persistent-skill' && capability.pluginId === pluginId,
  );
}

test('declared skill survives an abnormal Host exit and activates from the same stable source', async () => {
  const { installed, projectRoot } = await installAndEnableFixture();
  const beforeRestart = installedSkill(await readCapabilitiesConfig(projectRoot), installed.pluginId);
  assert.ok(beforeRestart?.skillsSource);
  const sourceBeforeRestart = resolve(projectRoot, beforeRestart.skillsSource);
  const realSourceBeforeRestart = await realpath(sourceBeforeRestart);
  await access(join(sourceBeforeRestart, 'persistent-skill/SKILL.md'));

  // Deliberately do not stop the first composition: this models a killed Host whose
  // in-memory runtime and staging leases disappear without lifecycle cleanup.
  const restarted = createRuntime(projectRoot);
  await restarted.supervisor.start(installed.pluginInstanceId);

  const afterRestart = installedSkill(await readCapabilitiesConfig(projectRoot), installed.pluginId);
  assert.equal(await realpath(resolve(projectRoot, afterRestart?.skillsSource ?? '')), realSourceBeforeRestart);
  assert.equal(
    await realpath(join(projectRoot, '.claude/skills/persistent-skill')),
    join(realSourceBeforeRestart, 'persistent-skill'),
  );
  await access(join(sourceBeforeRestart, 'persistent-skill/SKILL.md'));
  await restarted.shutdown();
});

test('Host shutdown and restart preserve the user-selected skill mount policy', async () => {
  const { installed, projectRoot, runtime } = await installAndEnableFixture();
  const capabilities = await readCapabilitiesConfig(projectRoot);
  const skill = installedSkill(capabilities, installed.pluginId);
  assert.ok(capabilities && skill);
  await writeCapabilitiesConfig(projectRoot, {
    ...capabilities,
    capabilities: capabilities.capabilities.map((capability) =>
      capability === skill ? { ...capability, mountPaths: ['claude'] } : capability,
    ),
  });

  await runtime.shutdown('host_shutdown');
  const restarted = createRuntime(projectRoot);
  await restarted.supervisor.start(installed.pluginInstanceId);

  const afterRestart = installedSkill(await readCapabilitiesConfig(projectRoot), installed.pluginId);
  assert.deepEqual(afterRestart?.mountPaths, ['claude']);
  await restarted.shutdown();
});

test('uninstall removes the declared skill and its Host-owned source directory', async () => {
  const { composition, installed, projectRoot } = await installAndEnableFixture();
  const activeSkill = installedSkill(await readCapabilitiesConfig(projectRoot), installed.pluginId);
  assert.ok(activeSkill?.skillsSource);
  const source = resolve(projectRoot, activeSkill.skillsSource);

  const beforeUninstall = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.uninstall(installed.pluginId, {
    expectedRevision: beforeUninstall.lifecycleRevision,
  });

  assert.equal(installedSkill(await readCapabilitiesConfig(projectRoot), installed.pluginId), undefined);
  await assert.rejects(access(source), /ENOENT/);
});

for (const selectedMounts of [['claude'], ['claude', 'codex']]) {
  test(`enabled package replacement preserves ${selectedMounts.join(',')} mount policy`, async () => {
    const { composition, installed, packageRoot, projectRoot, runtime } = await installAndEnableFixture();
    const config = await readCapabilitiesConfig(projectRoot);
    const before = installedSkill(config, installed.pluginId);
    before.mountPaths = selectedMounts;
    await writeCapabilitiesConfig(projectRoot, config);
    const previousPackageDigest = (await composition.manager.get(installed.pluginId)).plugin.packageDigest;
    const replacement = await tempRoot('cat-cafe-f202-replacement-skill-');
    await cp(packageRoot, replacement, { recursive: true });
    await writeFile(join(replacement, 'skills/persistent-skill/SKILL.md'), '# Updated skill\n');

    const updated = await composition.manager.install({ source: { kind: 'local-directory', path: replacement } });
    assert.equal(updated.pluginInstanceId, installed.pluginInstanceId);
    assert.notEqual((await composition.manager.get(installed.pluginId)).plugin.packageDigest, previousPackageDigest);
    const after = installedSkill(await readCapabilitiesConfig(projectRoot), installed.pluginId);
    assert.deepEqual(after.mountPaths, selectedMounts);
    assert.notEqual(after.skillsSource, before.skillsSource);
    for (const target of selectedMounts) {
      assert.equal(
        await realpath(join(projectRoot, `.${target}`, 'skills/persistent-skill')),
        await realpath(join(resolve(projectRoot, after.skillsSource), 'persistent-skill')),
      );
    }
    assert.equal(
      await realpath(join(projectRoot, '.claude/skills/persistent-skill')),
      await realpath(join(resolve(projectRoot, after.skillsSource), 'persistent-skill')),
    );
    assert.equal(
      await readFile(join(projectRoot, '.claude/skills/persistent-skill/SKILL.md'), 'utf8'),
      '# Updated skill\n',
    );
    assert.equal((await composition.manager.get(installed.pluginId)).plugin.live, 'running');
    // Returning to the previous package uses the same ownership transition.
    await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
    const restored = installedSkill(await readCapabilitiesConfig(projectRoot), installed.pluginId);
    assert.notEqual(restored.skillsSource, after.skillsSource);
    assert.equal(
      await realpath(join(projectRoot, '.claude/skills/persistent-skill')),
      await realpath(join(resolve(projectRoot, restored.skillsSource), 'persistent-skill')),
    );
    assert.equal(
      await readFile(join(projectRoot, '.claude/skills/persistent-skill/SKILL.md'), 'utf8'),
      '# Persistent Skill\n',
    );
    assert.deepEqual(restored.mountPaths, selectedMounts);
    await runtime.shutdown();
  });
}
for (const foreignKind of ['symlink', 'directory']) {
  test(`a package source change never removes a foreign skill ${foreignKind}`, async () => {
    const { addSkill } = await import('../dist/skills/skill-manage.js');
    const { readMountRules } = await import('../dist/config/mount/mount-rules-store.js');
    const { installed, packageRoot, projectRoot, runtime } = await installAndEnableFixture();
    const foreign = await tempRoot('cat-cafe-f202-foreign-skill-');
    await writeFile(join(foreign, 'SKILL.md'), '# User owned\n');
    const link = join(projectRoot, '.claude/skills/persistent-skill');
    await rm(link);
    if (foreignKind === 'symlink') await symlink(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
    else await cp(foreign, link, { recursive: true });
    const result = await addSkill(projectRoot, 'persistent-skill', join(packageRoot, 'skills'), {
      pluginId: installed.pluginId,
      skillsSource: join(packageRoot, 'skills'),
      mountPaths: ['claude'],
      mountRules: await readMountRules(projectRoot, projectRoot),
    });
    assert.ok(result.conflicts.some((conflict) => conflict.path === link));
    assert.equal(await realpath(link), await realpath(foreignKind === 'symlink' ? foreign : link));
    assert.equal(await readFile(join(link, 'SKILL.md'), 'utf8'), '# User owned\n');
    await runtime.shutdown();
  });
}
test('failure after replacement skill activation restores previous package, links and mount policy', async () => {
  let project;
  let observedNewSkillSource;
  const fixture = await installAndEnableFixture((root) => {
    project = root;
    return {
      mcpConfigIO: {
        withLock: (fn) => withCapabilityLock(project, fn),
        readConfig: () => readCapabilitiesConfig(project),
        writeAndRegenCli: async (config) => {
          if (config.capabilities.some((item) => item.type === 'mcp' && item.enabled)) {
            observedNewSkillSource = installedSkill(
              await readCapabilitiesConfig(project),
              'dev.clowder.persistent-skill-fixture',
            ).skillsSource;
            throw new Error('injected later MCP publication failure');
          }
          await writeCapabilitiesConfig(project, config);
        },
      },
    };
  });
  const { composition, installed, packageRoot, projectRoot, runtime } = fixture;
  project = projectRoot;
  const oldDetail = (await composition.manager.get(installed.pluginId)).plugin;
  const config = await readCapabilitiesConfig(projectRoot);
  const before = installedSkill(config, installed.pluginId);
  before.mountPaths = ['claude'];
  await writeCapabilitiesConfig(projectRoot, config);
  const replacement = await tempRoot('cat-cafe-f202-failing-skill-');
  await cp(packageRoot, replacement, { recursive: true });
  const manifest = JSON.parse(await readFile(join(replacement, 'manifest.json'), 'utf8'));
  manifest.contributions.push({
    type: 'mcp',
    id: 'later-mcp',
    runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
  });
  manifest.features[0].contributions.push({ type: 'mcp', id: 'later-mcp' });
  await writeFile(join(replacement, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(replacement, 'dist/mcp.js'), 'process.exit(0);');
  await writeFile(join(replacement, 'skills/persistent-skill/SKILL.md'), '# Replacement\n');
  await assert.rejects(composition.manager.install({ source: { kind: 'local-directory', path: replacement } }), {
    code: 'UPDATE_RESUME_FAILED',
  });
  assert.ok(observedNewSkillSource);
  assert.notEqual(observedNewSkillSource, before.skillsSource);
  const after = installedSkill(await readCapabilitiesConfig(projectRoot), installed.pluginId);
  assert.equal(after.skillsSource, before.skillsSource);
  assert.deepEqual(after.mountPaths, ['claude']);
  assert.equal(
    await realpath(join(projectRoot, '.claude/skills/persistent-skill')),
    await realpath(join(resolve(projectRoot, before.skillsSource), 'persistent-skill')),
  );
  const detail = (await composition.manager.get(installed.pluginId)).plugin;
  assert.equal(detail.packageDigest, oldDetail.packageDigest);
  assert.equal(detail.pluginInstanceId, oldDetail.pluginInstanceId);
  assert.equal(detail.live, 'running');
  await assert.rejects(access(join(projectRoot, '.codex/skills/persistent-skill')), /ENOENT/);
  await runtime.shutdown();
});
