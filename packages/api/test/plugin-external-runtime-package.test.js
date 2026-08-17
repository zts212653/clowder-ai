import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  ExternalPluginRuntimeError,
  ExternalPluginRuntimeSupervisor,
  FilesystemVerifiedPluginPackageLocator,
  packageDirectoryName,
} from '../dist/domains/plugin/external-runtime/index.js';
import {
  completeExternalHandshake,
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  EXTERNAL_PACKAGE_DIGEST,
  externalCandidate,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

const execFileAsync = promisify(execFile);

function isRuntimeError(code) {
  return (error) => error instanceof ExternalPluginRuntimeError && error.code === code;
}

async function startHarness({ manifest = externalManifest(), locatedManifest = manifest } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-package-'));
  const harness = await createExternalRuntimeHarness({ rootDir, manifest });
  const processes = new FakePluginProcessAdapter();
  const packages = {
    calls: [],
    async resolveInstalledPackage(packageDigest) {
      this.calls.push(packageDigest);
      return {
        rootDir,
        manifest: structuredClone(locatedManifest),
        verifyIntegrity: async () => undefined,
        release: async () => undefined,
      };
    },
  };
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages,
    processes,
  });
  return { ...harness, packages, processes, supervisor };
}

async function stageArchiveFixture(packagesRoot, manifest = externalManifest(), preparePackage) {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-archive-source-'));
  const packageRoot = join(sourceRoot, 'package');
  const archivePath = join(sourceRoot, 'package.tgz');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(join(packageRoot, 'dist/plugin.js'), '// admitted fixture entrypoint\n', 'utf8');
  if (preparePackage) await preparePackage(packageRoot);
  await execFileAsync('tar', ['czf', archivePath, '-C', sourceRoot, 'package']);
  const packageDigest = `sha512-${createHash('sha512')
    .update(await readFile(archivePath))
    .digest('base64')}`;
  const artifactRoot = join(packagesRoot, packageDirectoryName(packageDigest));
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(join(artifactRoot, 'package.tgz'), await readFile(archivePath));

  // The old locator reads these mutable files directly. The sealed-archive locator must ignore them.
  await mkdir(join(artifactRoot, 'dist'), { recursive: true });
  await writeFile(join(artifactRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(join(artifactRoot, 'dist/plugin.js'), '// mutable legacy entrypoint\n', 'utf8');
  return { artifactRoot, packageDigest };
}

test('starts only the Host-selected digest and passes a closed non-secret bootstrap environment', async () => {
  const harness = await startHarness();
  const previousToken = process.env.NPM_TOKEN;
  const previousRedis = process.env.REDIS_URL;
  process.env.NPM_TOKEN = 'must-not-leak';
  process.env.REDIS_URL = 'redis://must-not-leak';
  try {
    const starting = harness.supervisor.start(EXTERNAL_INSTANCE_ID);
    const child = await harness.processes.nextProcess();
    const handshake = await completeExternalHandshake(child);
    const handle = await starting;

    assert.equal(handshake.ready.result, null);
    assert.equal(handle.pluginInstanceId, EXTERNAL_INSTANCE_ID);
    assert.deepEqual(harness.packages.calls, [EXTERNAL_PACKAGE_DIGEST]);
    assert.equal(harness.processes.specs.length, 1);
    assert.deepEqual(harness.processes.specs[0], {
      command: process.execPath,
      args: [join(harness.rootDir, 'dist/plugin.js')],
      cwd: harness.rootDir,
      env: {
        CLOWDER_PLUGIN_ID: 'official.external-source',
        CLOWDER_PACKAGE_DIGEST: EXTERNAL_PACKAGE_DIGEST,
        CLOWDER_CONTRACT_VERSION: '0.1.0',
        CLOWDER_WIRE_VERSION: '0.1.0',
      },
    });
    assert.equal('NPM_TOKEN' in harness.processes.specs[0].env, false);
    assert.equal('REDIS_URL' in harness.processes.specs[0].env, false);
    assert.equal('PATH' in harness.processes.specs[0].env, false);

    await harness.supervisor.stop(EXTERNAL_INSTANCE_ID, 'test_complete');
    assert.equal(child.terminateCalls, 1);
  } finally {
    if (previousToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousToken;
    if (previousRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedis;
  }
});

test('rejects builtin package truth instead of reinterpreting it as stdio', async () => {
  const manifest = externalManifest({ transport: 'builtin' });
  const harness = await startHarness({ manifest });
  await assert.rejects(harness.supervisor.start(EXTERNAL_INSTANCE_ID), isRuntimeError('UNSUPPORTED_TRANSPORT'));
  assert.equal(harness.processes.specs.length, 0);
});

test('rejects locator manifest drift before spawn', async () => {
  const harness = await startHarness({
    locatedManifest: { ...externalManifest(), pluginId: 'official.other-source' },
  });
  await assert.rejects(harness.supervisor.start(EXTERNAL_INSTANCE_ID), isRuntimeError('PACKAGE_AUTHORITY_MISMATCH'));
  assert.equal(harness.processes.specs.length, 0);
});

test('filesystem locator derives a path from the Host digest and validates the public manifest', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-locator-'));
  const directoryName = packageDirectoryName(EXTERNAL_PACKAGE_DIGEST);
  assert.match(directoryName, /^[a-f0-9]{64}$/);
  const { packageDigest } = await stageArchiveFixture(packagesRoot);
  const expectedDirectoryName = packageDirectoryName(packageDigest);
  const locator = new FilesystemVerifiedPluginPackageLocator(packagesRoot);
  const located = await locator.resolveInstalledPackage(packageDigest);
  assert.deepEqual(located.manifest, externalManifest());
  assert.notEqual(located.rootDir, join(packagesRoot, expectedDirectoryName));
  await located.verifyIntegrity();
  await located.release();
  await assert.rejects(access(located.rootDir));
});

test('starts an admitted archive from a private verified stage and releases it after stop', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-private-stage-'));
  const { artifactRoot, packageDigest } = await stageArchiveFixture(packagesRoot);
  const harness = await createExternalRuntimeHarness({
    rootDir: await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-private-stage-harness-')),
    packageDigest,
  });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: new FilesystemVerifiedPluginPackageLocator(packagesRoot),
    processes,
  });

  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await processes.nextProcess();
  await completeExternalHandshake(child, externalCandidate({ packageDigest }));
  await starting;
  const stageRoot = processes.specs[0].cwd;
  assert.notEqual(stageRoot, artifactRoot);
  await access(stageRoot);

  await supervisor.stop(EXTERNAL_INSTANCE_ID, 'test_complete');
  await assert.rejects(access(stageRoot));
});

test('rejects staged archive bytes that differ from the admitted SRI and performs zero spawn', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-tampered-archive-'));
  const { artifactRoot, packageDigest } = await stageArchiveFixture(packagesRoot);
  await writeFile(join(artifactRoot, 'package.tgz'), 'tampered archive bytes', 'utf8');
  const harness = await createExternalRuntimeHarness({
    rootDir: await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-tampered-archive-harness-')),
    packageDigest,
  });
  const processes = {
    specs: [],
    async spawn(spec) {
      this.specs.push(spec);
      throw new Error('tampered archive must not reach spawn');
    },
  };
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: new FilesystemVerifiedPluginPackageLocator(packagesRoot),
    processes,
  });

  await assert.rejects(supervisor.start(EXTERNAL_INSTANCE_ID), isRuntimeError('PACKAGE_AUTHORITY_MISMATCH'));
  assert.equal(processes.specs.length, 0);
});

test('rejects a symlink from the staged archive before spawn', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-symlink-archive-'));
  const { packageDigest } = await stageArchiveFixture(packagesRoot, externalManifest(), async (packageRoot) => {
    const entrypoint = join(packageRoot, 'dist/plugin.js');
    await rm(entrypoint);
    await writeFile(join(packageRoot, 'dist/target.js'), '// symlink target\n', 'utf8');
    await symlink('target.js', entrypoint);
  });
  const harness = await createExternalRuntimeHarness({
    rootDir: await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-symlink-archive-harness-')),
    packageDigest,
  });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: new FilesystemVerifiedPluginPackageLocator(packagesRoot),
    processes,
  });

  await assert.rejects(supervisor.start(EXTERNAL_INSTANCE_ID), isRuntimeError('PACKAGE_AUTHORITY_MISMATCH'));
  assert.equal(processes.specs.length, 0);
});

test('rejects a regular-file mutation after verified staging and performs zero spawn', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-tampered-file-'));
  const { packageDigest } = await stageArchiveFixture(packagesRoot);
  const locator = new FilesystemVerifiedPluginPackageLocator(packagesRoot);
  const harness = await createExternalRuntimeHarness({
    rootDir: await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-tampered-harness-')),
    packageDigest,
  });
  const processes = {
    specs: [],
    async spawn(spec) {
      this.specs.push(spec);
      throw new Error('tampered package must not reach spawn');
    },
  };
  const packages = {
    async resolveInstalledPackage(packageDigest) {
      const located = await locator.resolveInstalledPackage(packageDigest);
      await writeFile(join(located.rootDir, 'dist/plugin.js'), '// post-stage mutation\n', 'utf8');
      return located;
    },
  };
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages,
    processes,
  });

  await assert.rejects(supervisor.start(EXTERNAL_INSTANCE_ID), isRuntimeError('PACKAGE_AUTHORITY_MISMATCH'));
  assert.equal(processes.specs.length, 0);
});

test('rechecks the staged tree after runtime-state projection and performs zero spawn', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-projection-mutation-'));
  const { packageDigest } = await stageArchiveFixture(packagesRoot);
  const locator = new FilesystemVerifiedPluginPackageLocator(packagesRoot);
  const harness = await createExternalRuntimeHarness({
    rootDir: await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-projection-mutation-harness-')),
    packageDigest,
  });
  let located;
  let mutationCount = 0;
  const packages = {
    async resolveInstalledPackage(candidateDigest) {
      located = await locator.resolveInstalledPackage(candidateDigest);
      return located;
    },
  };
  const inventory = {
    snapshot: () => harness.inventory.snapshot(),
    async transaction(work) {
      const result = await harness.inventory.transaction(work);
      if (mutationCount === 0) {
        assert.ok(located, 'package must be staged before projecting runtime state');
        await writeFile(join(located.rootDir, 'dist/plugin.js'), '// altered after projection\n', 'utf8');
        mutationCount += 1;
      }
      return result;
    },
  };
  const processes = {
    specs: [],
    async spawn(spec) {
      this.specs.push(spec);
      throw new Error('post-projection mutation must not reach spawn');
    },
  };
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory,
    broker: harness.broker,
    packages,
    processes,
  });

  await assert.rejects(supervisor.start(EXTERNAL_INSTANCE_ID), isRuntimeError('PACKAGE_AUTHORITY_MISMATCH'));
  assert.equal(mutationCount, 1);
  assert.equal(processes.specs.length, 0);
});

test('rejects traversal and symlink entrypoints before spawn', async (t) => {
  await t.test('traversal', async () => {
    const manifest = externalManifest({ transport: 'stdio', entrypoint: '../outside.js' });
    const harness = await startHarness({ manifest });
    await writeFile(join(dirname(harness.rootDir), 'outside.js'), '// outside\n', 'utf8');
    await assert.rejects(harness.supervisor.start(EXTERNAL_INSTANCE_ID), isRuntimeError('INVALID_ENTRYPOINT'));
    assert.equal(harness.processes.specs.length, 0);
  });

  await t.test('symlink', async () => {
    const harness = await startHarness();
    const target = join(harness.rootDir, 'dist/target.js');
    const link = join(harness.rootDir, 'dist/plugin.js');
    await writeFile(target, '// target\n', 'utf8');
    await writeFile(link, '// replace me\n', 'utf8');
    await rm(link);
    await symlink(target, link);
    await assert.rejects(harness.supervisor.start(EXTERNAL_INSTANCE_ID), isRuntimeError('INVALID_ENTRYPOINT'));
    assert.equal(harness.processes.specs.length, 0);
  });
});
