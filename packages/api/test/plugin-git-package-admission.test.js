import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createGitCloneEnvironment,
  createPluginManagerRuntimeComposition,
  GitPluginPackageAdmission,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

const execFileAsync = promisify(execFile);
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function writeGitPluginRepository() {
  const root = await tempRoot('cat-cafe-f202-git-plugin-');
  const manifest = {
    pluginId: 'dev.clowder.git-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Git Fixture',
    contributions: [],
    features: [{ id: 'main', name: 'Main', resources: [], contributions: [], capabilities: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(root, 'dist/plugin.js'),
    'export default { create() { return { start() { return { actions: {}, stop() {} }; } }; } };\n',
    'utf8',
  );
  await execFileAsync('git', ['init', '--quiet', root]);
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Git Fixture']);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  await execFileAsync('git', ['-C', root, 'add', '--', '.']);
  await execFileAsync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

async function composition(projectRoot, overrides = {}) {
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const manager = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    ...overrides,
  });
  return { runtime, manager };
}

async function cloneStages(projectRoot) {
  const hostRoot = resolve(projectRoot, '.cat-cafe/plugin-host');
  const entries = await readdir(hostRoot).catch(() => []);
  return entries.filter((entry) => entry.startsWith('.git-install-'));
}

test('installs, enables, and uninstalls a package from a local git URL without retaining clone state', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-git-project-');
  const repository = await writeGitPluginRepository();
  const { runtime, manager } = await composition(projectRoot);
  const url = pathToFileURL(repository).href;

  const installed = await manager.manager.install({ source: { kind: 'git', url } });
  const beforeEnable = (await manager.manager.get(installed.pluginId)).plugin;
  assert.equal(beforeEnable.source.kind, 'git');
  assert.equal(beforeEnable.source.url, url);
  await manager.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  const enabled = (await runtime.inventoryStore.snapshot()).instances.find(
    (instance) => instance.pluginInstanceId === installed.pluginInstanceId,
  );
  assert.equal(enabled?.activationState, 'enabled');
  assert.deepEqual(await cloneStages(projectRoot), []);

  const beforeUninstall = (await manager.manager.get(installed.pluginId)).plugin;
  await manager.manager.uninstall(installed.pluginId, { expectedRevision: beforeUninstall.lifecycleRevision });
  assert.deepEqual(await cloneStages(projectRoot), []);
});

test('git admission closes protocols, disables prompts, and fences options', async () => {
  const productionPolicy = createGitCloneEnvironment();
  assert.equal(productionPolicy.GIT_ALLOW_PROTOCOL, 'https:ssh:git:file');
  assert.equal(productionPolicy.GIT_TERMINAL_PROMPT, '0');
  assert.equal(productionPolicy.GIT_CONFIG_GLOBAL, devNull);
  assert.equal(productionPolicy.GIT_CONFIG_NOSYSTEM, '1');

  const projectRoot = await tempRoot('cat-cafe-f202-git-policy-');
  const logPath = join(projectRoot, 'git-invocation.json');
  const fakeGit = join(projectRoot, 'fake-git');
  await writeFile(
    fakeGit,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(
      logPath,
    )}, JSON.stringify({ argv: process.argv.slice(2), allow: process.env.GIT_ALLOW_PROTOCOL, prompt: process.env.GIT_TERMINAL_PROMPT, globalConfig: process.env.GIT_CONFIG_GLOBAL, noSystemConfig: process.env.GIT_CONFIG_NOSYSTEM, sshCommand: process.env.GIT_SSH_COMMAND }));\nprocess.exitCode = 7;\n`,
    'utf8',
  );
  await chmod(fakeGit, 0o700);
  const { manager } = await composition(projectRoot);
  const admission = new GitPluginPackageAdmission({
    localAdmission: manager.localAdmission,
    cloneRoot: resolve(projectRoot, '.cat-cafe/plugin-host'),
    gitBin: fakeGit,
  });

  await assert.rejects(
    admission.install({ kind: 'git', url: 'https://example.invalid/private.git' }),
    (error) => error?.code === 'INVALID_LOCAL_SOURCE',
  );
  const invocation = JSON.parse(await readFile(logPath, 'utf8'));
  assert.deepEqual(invocation.argv, [
    'clone',
    '--depth',
    '1',
    '--no-tags',
    '--single-branch',
    '--no-recurse-submodules',
    '--',
    'https://example.invalid/private.git',
    invocation.argv.at(-1),
  ]);
  // The distributable public-test guard deliberately clamps every spawned Git
  // process to local file:// fixtures after the production policy is built.
  const observedProtocols =
    process.env.CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE === 'distributable' ? 'file' : 'https:ssh:git:file';
  assert.equal(invocation.allow, observedProtocols);
  assert.equal(invocation.prompt, '0');
  assert.equal(invocation.globalConfig, devNull);
  assert.equal(invocation.noSystemConfig, '1');
  assert.equal(invocation.sshCommand, undefined);
  assert.deepEqual(await cloneStages(projectRoot), []);
});

test('git admission times out a non-interactive clone and removes its stage', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-git-timeout-');
  const fakeGit = join(projectRoot, 'hanging-git');
  await writeFile(fakeGit, '#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n', 'utf8');
  await chmod(fakeGit, 0o700);
  const { manager } = await composition(projectRoot);
  const admission = new GitPluginPackageAdmission({
    localAdmission: manager.localAdmission,
    cloneRoot: resolve(projectRoot, '.cat-cafe/plugin-host'),
    gitBin: fakeGit,
    timeoutMs: 100,
  });

  await assert.rejects(
    admission.install({ kind: 'git', url: 'https://example.invalid/private.git' }),
    (error) => error?.code === 'INVALID_LOCAL_SOURCE',
  );
  assert.deepEqual(await cloneStages(projectRoot), []);
});

test('rejects option-like and command-transport git addresses before launching git', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-git-address-policy-');
  const { manager } = await composition(projectRoot);
  const admission = new GitPluginPackageAdmission({
    localAdmission: manager.localAdmission,
    cloneRoot: resolve(projectRoot, '.cat-cafe/plugin-host'),
  });

  for (const url of [
    '--upload-pack=bad',
    'ext::sh -c bad',
    'https://user:secret@example.invalid/plugin.git',
    'https://example.invalid/plugin.git?token=secret',
  ]) {
    await assert.rejects(admission.install({ kind: 'git', url }), (error) => error?.code === 'INVALID_LOCAL_SOURCE');
  }
  assert.deepEqual(await cloneStages(projectRoot), []);
});

test('explains the supported ssh URL form when a pasted scp-style address is rejected', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-git-scp-help-');
  const { manager } = await composition(projectRoot);
  const admission = new GitPluginPackageAdmission({
    localAdmission: manager.localAdmission,
    cloneRoot: resolve(projectRoot, '.cat-cafe/plugin-host'),
  });

  await assert.rejects(
    admission.install({ kind: 'git', url: 'git@example.invalid:team/plugin.git' }),
    (error) =>
      error?.code === 'INVALID_LOCAL_SOURCE' && error.message.includes('ssh://git@example.invalid/team/plugin.git'),
  );
  assert.deepEqual(await cloneStages(projectRoot), []);
});
