import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function createRuntime(projectRoot) {
  return createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
}

async function installAndEnableFixture() {
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

  const runtime = createRuntime(projectRoot);
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
  return { composition, installed, projectRoot, runtime };
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
