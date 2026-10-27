import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { FilesystemVerifiedPluginPackageLocator } from '../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import {
  ExternalPluginLifecycleService,
  FilePluginPackageQuarantineStore,
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
  OfficialPluginPackageInstaller,
  packageDirectoryName,
} from '../dist/domains/plugin/index.js';
import { catalogEntry, manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function writeLocalPackage(root, packageManifest = manifest(), entrypoint = '// local fixture\n') {
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'schemas'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(packageManifest)}\n`, 'utf8');
  await writeFile(join(root, 'dist/entrypoint.js'), entrypoint, 'utf8');
  await writeFile(
    join(root, 'schemas/official.test.v1.schema.json'),
    `${JSON.stringify({
      type: 'object',
      properties: { payload: { type: 'object' }, source: { type: 'object' } },
      required: ['payload', 'source'],
    })}\n`,
    'utf8',
  );
}

async function harness({ quarantine = false, npmBin } = {}) {
  const packagesRoot = await tempRoot('cat-cafe-f202-local-packages-');
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_local',
    now: () => 12_000,
  });
  const quarantineStore = quarantine
    ? new FilePluginPackageQuarantineStore(join(packagesRoot, 'quarantines.json'), { now: () => 12_000 })
    : undefined;
  const admission = new LocalPluginPackageAdmission({
    inventory,
    packagesRoot,
    ...(npmBin ? { npmBin } : {}),
    ...(quarantineStore ? { quarantine: quarantineStore } : {}),
  });
  return { admission, inventory, packagesRoot, store, quarantines: quarantineStore };
}

// Real npm CLI invoked through a generated shim. The shim mutates the original
// source while npm is packing the sealed snapshot, which is exactly the race the
// final source recheck must reject.
function npmCliEntrypoint() {
  const relative = join('node_modules', 'npm', 'bin', 'npm-cli.js');
  const candidates = [join(dirname(process.execPath), relative)];
  for (const bin of (process.env.PATH ?? '').split(delimiter)) {
    if (!bin) continue;
    candidates.push(join(bin, relative), join(bin, '..', 'lib', relative));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

async function npmShim(mutation) {
  const npmCli = npmCliEntrypoint();
  assert.ok(npmCli, 'the npm CLI entrypoint is required for the source-change regression');
  const shimPath = join(await tempRoot('cat-cafe-local-npm-shim-'), 'npm-shim.mjs');
  const source = `import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pack' && args.some((value) => value.startsWith('--pack-destination='))) {
${mutation}
}
const result = spawnSync(process.execPath, [${JSON.stringify(npmCli)}, ...args], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
process.exit(result.status ?? 1);
`;
  await writeFile(shimPath, source, 'utf8');
  return shimPath;
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarEntry({ name, body = Buffer.alloc(0), type = '0', linkName = '' }) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(body.byteLength, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512, 0);
  return Buffer.concat([header, body, padding]);
}

function maliciousArchive(entries) {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024, 0)]));
}

test('admits a local npm-style archive into immutable Host inventory without executing its entrypoint', async () => {
  const sideEffect = join(await tempRoot('cat-cafe-f202-local-side-effect-'), 'executed');
  const archive = await packageArchive({
    packageManifest: {
      ...manifest(),
      features: manifest().features.map((feature) => ({
        ...feature,
        capabilities: [...feature.capabilities, 'task.admitEntrusted'],
      })),
    },
  });
  const archivePath = join(await tempRoot('cat-cafe-f202-local-archive-'), 'plugin.tgz');
  await writeFile(archivePath, archive.bytes);
  const { admission, packagesRoot, store } = await harness();

  const result = await admission.install({ kind: 'local-archive', path: archivePath });

  assert.equal(result.pluginId, 'official.test-source');
  assert.equal(result.pluginInstanceId, 'pi_local');
  assert.equal(result.packageDigest, archive.integrity);
  await access(join(packagesRoot, packageDirectoryName(archive.integrity), 'package.tgz'));
  await assert.rejects(access(sideEffect), { code: 'ENOENT' });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.packages[0].packageState, 'installed');
  assert.deepEqual(snapshot.packages[0].provenance, {
    kind: 'local-archive',
    packageName: '@clowder-ai/official-test-source',
  });
});

test('copies a local directory into an immutable canonical archive before inventory admission', async () => {
  const sourceRoot = await tempRoot('cat-cafe-f202-local-directory-');
  const sideEffect = join(sourceRoot, 'entrypoint-executed');
  await writeLocalPackage(
    sourceRoot,
    manifest(),
    `await import('node:fs/promises').then(({ writeFile }) => writeFile(${JSON.stringify(sideEffect)}, 'bad'));\n`,
  );
  const { admission, packagesRoot, store } = await harness();

  const result = await admission.install({ kind: 'local-directory', path: sourceRoot });

  assert.equal(result.pluginId, 'official.test-source');
  assert.equal(result.pluginInstanceId, 'pi_local');
  assert.match(result.packageDigest, /^sha512-[A-Za-z0-9+/]{86}==$/);
  await access(join(packagesRoot, packageDirectoryName(result.packageDigest), 'package.tgz'));
  await assert.rejects(access(sideEffect), { code: 'ENOENT' });
  assert.equal((await store.snapshot()).instances.length, 1);
});

test('packages a local directory whose source path resembles pnpm .pnpm', async () => {
  const root = await tempRoot('cat-cafe-local-pnpm-path-');
  const sourceRoot = join(root, 'node_modules', '.pnpm', 'fixture@1.0.0', 'node_modules', 'fixture');
  await writeLocalPackage(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    `${JSON.stringify({ name: '@clowder-ai/official-test-source', version: '1.0.0' })}\n`,
    'utf8',
  );
  const { admission } = await harness();

  const result = await admission.install({ kind: 'local-directory', path: sourceRoot });

  assert.equal(result.pluginId, 'official.test-source');
  assert.match(result.packageDigest, /^sha512-[A-Za-z0-9+/]{86}==$/);
});

test('publishes nested node_modules fixtures without copying the root dependency directory', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-nested-node-modules-');
  await writeLocalPackage(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    `${JSON.stringify({ name: '@clowder-ai/official-test-source', version: '1.0.0' })}\n`,
    'utf8',
  );
  const member = 'test/fixtures/eval/node_modules/file1.js';
  await mkdir(join(sourceRoot, 'test/fixtures/eval/node_modules'), { recursive: true });
  await writeFile(join(sourceRoot, member), 'module.exports = 17;\n', 'utf8');
  await mkdir(join(sourceRoot, 'node_modules/unlisted-dependency'), { recursive: true });
  await writeFile(join(sourceRoot, 'node_modules/unlisted-dependency/index.js'), 'module.exports = 0;\n', 'utf8');
  const { admission, packagesRoot } = await harness();

  const result = await admission.install({ kind: 'local-directory', path: sourceRoot });
  const located = await new FilesystemVerifiedPluginPackageLocator(packagesRoot).resolveInstalledPackage(
    result.packageDigest,
  );
  try {
    assert.equal(await readFile(join(located.rootDir, member), 'utf8'), 'module.exports = 17;\n');
    await assert.rejects(access(join(located.rootDir, 'node_modules/unlisted-dependency/index.js')));
  } finally {
    await located.release();
  }
});

test('rejects a published member added to the source while npm packs the sealed snapshot', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-late-member-');
  await writeLocalPackage(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    `${JSON.stringify({ name: '@clowder-ai/official-test-source', version: '1.0.0' })}\n`,
    'utf8',
  );
  const late = join(sourceRoot, 'late.js');
  const shim = await npmShim(`  writeFileSync(${JSON.stringify(late)}, 'module.exports = 1;\\n');`);
  const { admission, store } = await harness({ npmBin: shim });

  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error.code === 'INVALID_LOCAL_SOURCE' && error.cause?.code === 'DEPENDENCY_SOURCE_CHANGED',
  );
  assert.equal(await readFile(late, 'utf8'), 'module.exports = 1;\n', 'the shim must mutate the original source');
  assert.deepEqual((await store.snapshot()).instances, []);
  assert.deepEqual((await store.snapshot()).packages, []);
});

test('rejects an .npmignore edited while npm packs the sealed snapshot', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-ignore-change-');
  await writeLocalPackage(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    `${JSON.stringify({ name: '@clowder-ai/official-test-source', version: '1.0.0' })}\n`,
    'utf8',
  );
  // Same byte length before and after, so a size-only comparison cannot see the
  // selection change; the recheck also hashes selection files.
  const npmIgnore = join(sourceRoot, '.npmignore');
  await writeFile(npmIgnore, 'dist\n', 'utf8');
  const shim = await npmShim(`  writeFileSync(${JSON.stringify(npmIgnore)}, 'test\\n');`);
  const { admission, store } = await harness({ npmBin: shim });

  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error.code === 'INVALID_LOCAL_SOURCE' && error.cause?.code === 'DEPENDENCY_SOURCE_CHANGED',
  );
  assert.equal(await readFile(npmIgnore, 'utf8'), 'test\n', 'the shim must rewrite the selection file');
  assert.deepEqual((await store.snapshot()).instances, []);
  assert.deepEqual((await store.snapshot()).packages, []);
});

test('bounds pack source copies before an ignored large cache is duplicated', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-ignored-cache-');
  await writeLocalPackage(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    `${JSON.stringify({ name: '@clowder-ai/official-test-source', version: '1.0.0' })}\n`,
    'utf8',
  );
  await writeFile(join(sourceRoot, '.npmignore'), 'cache\n', 'utf8');
  await mkdir(join(sourceRoot, 'cache'));
  const handle = await open(join(sourceRoot, 'cache/ignored.bin'), 'w');
  try {
    await handle.truncate(65 * 1024 * 1024);
  } finally {
    await handle.close();
  }
  const { admission, packagesRoot, store } = await harness();

  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error.code === 'INVALID_LOCAL_SOURCE' && error.cause?.code === 'DEPENDENCY_PREPARATION_LIMIT',
  );
  assert.deepEqual((await store.snapshot()).instances, []);
  assert.equal(
    (await readdir(packagesRoot)).some((entry) => entry.startsWith('.directory-prepare-')),
    false,
  );
});

test('applies the pack source budget across every package in the dependency graph', async () => {
  const workspace = await tempRoot('cat-cafe-local-shared-budget-');
  const sourceRoot = join(workspace, 'packages', 'plugin');
  const dependencyRoot = join(workspace, 'packages', 'runtime');
  await writeLocalPackage(sourceRoot);
  await writeLocalPackage(dependencyRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    `${JSON.stringify({
      name: '@clowder-ai/official-test-source',
      version: '1.0.0',
      dependencies: { 'runtime-dependency': '1.0.0' },
    })}\n`,
    'utf8',
  );
  await writeFile(
    join(dependencyRoot, 'package.json'),
    `${JSON.stringify({ name: 'runtime-dependency', version: '1.0.0' })}\n`,
    'utf8',
  );
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n", 'utf8');
  await writeFile(
    join(workspace, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'

importers:
  .: {}
  packages/plugin:
    dependencies:
      runtime-dependency:
        specifier: 1.0.0
        version: link:../runtime
  packages/runtime: {}

packages: {}
snapshots: {}
`,
    'utf8',
  );
  await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
  await symlink(
    dependencyRoot,
    join(sourceRoot, 'node_modules', 'runtime-dependency'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const root of [sourceRoot, dependencyRoot]) {
    await writeFile(join(root, '.npmignore'), 'cache\n', 'utf8');
    await mkdir(join(root, 'cache'));
    const handle = await open(join(root, 'cache/ignored.bin'), 'w');
    try {
      await handle.truncate(40 * 1024 * 1024);
    } finally {
      await handle.close();
    }
  }
  const { admission, packagesRoot, store } = await harness();

  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error.code === 'INVALID_LOCAL_SOURCE' && error.cause?.code === 'DEPENDENCY_PREPARATION_LIMIT',
  );
  assert.deepEqual((await store.snapshot()).instances, []);
  assert.equal(
    (await readdir(packagesRoot)).some((entry) => entry.startsWith('.directory-prepare-')),
    false,
  );
});

test('cancels an in-flight pack source copy and releases its staging directory', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-copy-cancel-');
  await writeLocalPackage(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    `${JSON.stringify({ name: '@clowder-ai/official-test-source', version: '1.0.0' })}\n`,
    'utf8',
  );
  await mkdir(join(sourceRoot, 'bulk'));
  for (let index = 0; index < 400; index++)
    await writeFile(join(sourceRoot, `bulk/file-${index}.txt`), 'x'.repeat(1024), 'utf8');
  const { admission, packagesRoot, store } = await harness();
  const controller = new AbortController();
  const reason = new Error('pack source copy cancelled');
  let copySeen = false;
  let observing = false;
  let observationError;
  const timer = setInterval(async () => {
    if (observing || copySeen) return;
    observing = true;
    try {
      const entries = await readdir(packagesRoot).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries.filter((name) => name.startsWith('.directory-prepare-'))) {
        const packSource = join(packagesRoot, entry, 'pack-sources', '0');
        if (!existsSync(packSource)) continue;
        copySeen = true;
        controller.abort(reason);
      }
    } catch (error) {
      observationError = error;
      controller.abort(error);
    } finally {
      observing = false;
    }
  }, 1);
  try {
    await assert.rejects(
      admission.install({ kind: 'local-directory', path: sourceRoot }, { signal: controller.signal }),
      (error) => error === reason || error.cause === reason,
    );
    assert.equal(observationError, undefined);
    assert.equal(copySeen, true, 'cancel only after the bounded copy starts');
    assert.deepEqual((await store.snapshot()).instances, []);
    assert.deepEqual((await store.snapshot()).packages, []);
    assert.equal(
      (await readdir(packagesRoot)).some((entry) => entry.startsWith('.directory-prepare-')),
      false,
    );
  } finally {
    clearInterval(timer);
  }
});

test('rejects a traversal archive before publishing bytes or mutating inventory', async () => {
  const archivePath = join(await tempRoot('cat-cafe-f202-local-traversal-'), 'traversal.tgz');
  const bytes = maliciousArchive([
    { name: 'package/', type: '5' },
    { name: 'package/../../escape', body: Buffer.from('escaped') },
  ]);
  await writeFile(archivePath, bytes);
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const { admission, packagesRoot, store, quarantines } = await harness({ quarantine: true });

  await assert.rejects(
    admission.install({ kind: 'local-archive', path: archivePath }),
    (error) => error?.code === 'INVALID_PACKAGE_ARCHIVE',
  );
  await assert.rejects(access(join(packagesRoot, packageDirectoryName(digest), 'package.tgz')));
  assert.equal((await store.snapshot()).instances.length, 0);
  const [rejected] = await quarantines.list();
  assert.equal(rejected.packageDigest, digest);
  assert.equal(rejected.failure.code, 'INVALID_PACKAGE_ARCHIVE');
  assert.deepEqual(rejected.source, { kind: 'local-archive' });
});

test('rejects archive symlinks before extraction can escape the private stage', async () => {
  const externalRoot = await tempRoot('cat-cafe-f202-local-symlink-target-');
  const escapedPath = join(externalRoot, 'escaped');
  const archivePath = join(await tempRoot('cat-cafe-f202-local-symlink-'), 'symlink.tgz');
  const bytes = maliciousArchive([
    { name: 'package/', type: '5' },
    { name: 'package/link', type: '2', linkName: externalRoot },
    { name: 'package/link/escaped', body: Buffer.from('escaped') },
  ]);
  await writeFile(archivePath, bytes);
  const { admission, store } = await harness();

  await assert.rejects(
    admission.install({ kind: 'local-archive', path: archivePath }),
    (error) => error?.code === 'INVALID_PACKAGE_ARCHIVE',
  );
  await assert.rejects(access(escapedPath), { code: 'ENOENT' });
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('rejects local directory symlinks without reading or packaging their target', async () => {
  const sourceRoot = await tempRoot('cat-cafe-f202-local-directory-symlink-');
  const externalRoot = await tempRoot('cat-cafe-f202-local-directory-external-');
  await writeLocalPackage(sourceRoot);
  await writeFile(join(externalRoot, 'secret'), 'private', 'utf8');
  await symlink(externalRoot, join(sourceRoot, 'linked'));
  const { admission, store } = await harness();

  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error?.code === 'INVALID_LOCAL_SOURCE',
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('refuses an unproven pnpm physical dependency tree before admission', async () => {
  const sourceRoot = await tempRoot('cat-cafe-f202-local-directory-pnpm-');
  await writeLocalPackage(sourceRoot);
  const packageStore = join(sourceRoot, 'node_modules', '.pnpm', 'fixture@1.0.0', 'node_modules', 'fixture');
  await mkdir(packageStore, { recursive: true });
  await writeFile(join(packageStore, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(
    join(sourceRoot, 'package.json'),
    '{"name":"@clowder-ai/official-test-source","version":"1.0.0","dependencies":{"fixture":"1.0.0"}}\n',
  );
  await symlink('.pnpm/fixture@1.0.0/node_modules/fixture', join(sourceRoot, 'node_modules', 'fixture'));
  const { admission, store } = await harness();
  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error?.code === 'INVALID_LOCAL_SOURCE' && error.cause?.code === 'DEPENDENCY_LOCK_MISSING',
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('records shipped or materialized closure for immutable owner archives', async () => {
  const packageJson = JSON.stringify({
    name: '@clowder-ai/official-test-source',
    version: '1.0.0',
    dependencies: { fixture: '1.0.0' },
  });
  for (const closure of ['shipped', 'materialized']) {
    const archive = await packageArchive({
      extraFiles: {
        'package.json': packageJson,
        ...(closure === 'shipped'
          ? { 'node_modules/fixture/package.json': '{"name":"fixture","version":"1.0.0"}' }
          : {}),
      },
    });
    const archivePath = join(await tempRoot('cat-cafe-f202-local-closure-'), 'package.tgz');
    await writeFile(archivePath, archive.bytes);
    const { admission, store } = await harness();
    await admission.install({ kind: 'local-archive', path: archivePath });
    assert.equal((await store.snapshot()).packages[0].provenance.dependencyClosure, closure);
  }
});

test('rejects manifest/schema mismatch with zero inventory mutation', async () => {
  const sourceRoot = await tempRoot('cat-cafe-f202-local-schema-mismatch-');
  await writeLocalPackage(sourceRoot);
  await rm(join(sourceRoot, 'schemas/official.test.v1.schema.json'));
  const { admission, store } = await harness();

  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error?.code === 'INVALID_PACKAGE_SCHEMA',
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('rejects a source that changes its archive digest before admission', async () => {
  const archive = await packageArchive();
  const archivePath = join(await tempRoot('cat-cafe-f202-local-digest-race-'), 'plugin.tgz');
  await writeFile(archivePath, archive.bytes);
  const { admission, store } = await harness();

  await assert.rejects(
    admission.install(
      { kind: 'local-archive', path: archivePath },
      { expectedDigest: `sha512-${createHash('sha512').update('different').digest('base64')}` },
    ),
    (error) => error?.code === 'PACKAGE_DIGEST_MISMATCH',
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('owner directory reselection upgrades a failed stopped instance without discarding history or data', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-update-');
  await writeLocalPackage(sourceRoot);
  const { admission, packagesRoot, store } = await harness();
  const first = await admission.install({ kind: 'local-directory', path: sourceRoot });
  const error = { code: 'UNEXPECTED_RUNTIME_FAILURE', exitCode: 1, signal: null, occurredAt: 12000 };
  await store.transaction((tx) => {
    const instance = tx.instances.get(first.pluginInstanceId);
    tx.instances.put({ ...instance, activationState: 'error', lastRuntimeError: error });
  });
  const before = await store.snapshot();
  const dataFile = join(packagesRoot, 'owner-data-kept');
  await writeFile(dataFile, 'retained');
  await writeFile(join(sourceRoot, 'dist/entrypoint.js'), '// repaired local module\n');
  const updated = await admission.install({ kind: 'local-directory', path: sourceRoot });
  const after = await store.snapshot();
  assert.equal(updated.pluginInstanceId, first.pluginInstanceId);
  assert.notEqual(updated.packageDigest, first.packageDigest);
  assert.equal(after.instances.length, 1);
  assert.equal(after.instances[0].installedAt, before.instances[0].installedAt);
  assert.equal(after.instances[0].lifecycleRevision, before.instances[0].lifecycleRevision + 1);
  assert.deepEqual(after.instances[0].lastRuntimeError, error);
  assert.ok(after.packages.some((p) => p.packageDigest === first.packageDigest));
  await access(join(packagesRoot, packageDirectoryName(first.packageDigest), 'package.tgz'));
  assert.equal(await readFile(dataFile, 'utf8'), 'retained');
});

test('directory reselection cannot replace a running instance', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-update-running-');
  await writeLocalPackage(sourceRoot);
  const { admission, store } = await harness();
  const installed = await admission.install({ kind: 'local-directory', path: sourceRoot });
  await store.transaction((tx) => {
    tx.instances.put({
      ...tx.instances.get(installed.pluginInstanceId),
      runtimeState: 'healthy',
      activationState: 'enabled',
    });
  });
  const before = await store.snapshot();
  await writeFile(join(sourceRoot, 'dist/entrypoint.js'), '// update\n');
  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error.code === 'INVENTORY_REJECTED' && error.cause?.code === 'RUNTIME_NOT_STOPPED',
  );
  assert.deepEqual(await store.snapshot(), before);
});

test('explicit directory installation replaces an installed catalog identity while preserving the instance and data', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-update-origin-');
  await writeLocalPackage(sourceRoot, manifest({ version: '0.1.0-alpha.2' }));
  const { admission, inventory, store, packagesRoot } = await harness();
  const archive = await packageArchive();
  const entry = catalogEntry(archive.integrity);
  const official = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [entry],
    fetchArchive: async () => archive.bytes,
  });
  const first = await official.install(entry.catalogId, { version: entry.version, packageDigest: entry.packageDigest });
  const data = join(packagesRoot, 'retained-data');
  await writeFile(data, 'keep');
  const replaced = await admission.install({ kind: 'local-directory', path: sourceRoot });
  assert.equal(replaced.pluginInstanceId, first.pluginInstanceId);
  const after = await store.snapshot();
  assert.equal(after.instances.length, 1);
  assert.equal(
    after.packages.find((record) => record.packageDigest === replaced.packageDigest).provenance.kind,
    'local-directory',
  );
  assert.equal(await readFile(data, 'utf8'), 'keep');
});

test('directory replacement suspends and resumes the same enabled instance through the existing lifecycle queue', async () => {
  const directory = await tempRoot('cat-cafe-local-update-enabled-');
  await writeLocalPackage(directory);
  const h = await harness();
  const first = await h.admission.install({ kind: 'local-directory', path: directory });
  await h.store.transaction((tx) =>
    tx.instances.put({
      ...tx.instances.get(first.pluginInstanceId),
      activationState: 'enabled',
      runtimeState: 'healthy',
      configReadiness: 'ready',
    }),
  );
  const calls = [];
  const lifecycle = new ExternalPluginLifecycleService({
    store: h.store,
    supervisor: {
      stop: async (id) => calls.push(['stop', id, (await h.store.snapshot()).instances[0].packageDigest]),
      start: async (id) => calls.push(['start', id, (await h.store.snapshot()).instances[0].packageDigest]),
    },
  });
  const admission = new LocalPluginPackageAdmission({
    inventory: h.inventory,
    packagesRoot: h.packagesRoot,

    lifecycle,
  });
  await writeFile(join(directory, 'dist/entrypoint.js'), '// replacement');
  const result = await admission.install({ kind: 'local-directory', path: directory });
  assert.deepEqual(calls, [
    ['stop', first.pluginInstanceId, first.packageDigest],
    ['start', first.pluginInstanceId, result.packageDigest],
  ]);
  assert.equal((await h.store.snapshot()).instances[0].activationState, 'enabled');
});

for (const origin of ['catalog', 'local']) {
  for (const failOld of [false, true]) {
    test(`failed enabled ${origin} replacement restores old coordinates (old start fails: ${failOld})`, async () => {
      const directory = await tempRoot('cat-cafe-update-rollback-');
      await writeLocalPackage(directory);
      const h = await harness();
      let first;
      if (origin === 'catalog') {
        const archive = await packageArchive();
        const entry = catalogEntry(archive.integrity);
        first = await new OfficialPluginPackageInstaller({
          inventory: h.inventory,
          packagesRoot: h.packagesRoot,
          catalog: [entry],
          fetchArchive: async () => archive.bytes,
        }).install(entry.catalogId, { version: entry.version, packageDigest: entry.packageDigest });
      } else first = await h.admission.install({ kind: 'local-directory', path: directory });
      await h.store.transaction((tx) =>
        tx.instances.put({
          ...tx.instances.get(first.pluginInstanceId),
          activationState: 'enabled',
          runtimeState: 'healthy',
          configReadiness: 'ready',
        }),
      );
      const before = await h.store.snapshot();
      const retained = join(h.packagesRoot, 'owner-config-and-data');
      await writeFile(retained, 'owner settings and retained data');
      const starts = [];
      const reports = [];
      const lifecycle = new ExternalPluginLifecycleService({
        store: h.store,
        onStartFailure: (report) => reports.push(report),
        supervisor: {
          stop: async () => {},
          start: async (id) => {
            const instance = (await h.store.snapshot()).instances[0];
            starts.push(instance.packageDigest);
            if (instance.packageDigest !== first.packageDigest || failOld) throw new Error('fixture start failed');
            await h.store.transaction((tx) => tx.instances.put({ ...tx.instances.get(id), runtimeState: 'healthy' }));
          },
        },
      });
      const admission = new LocalPluginPackageAdmission({
        inventory: h.inventory,
        packagesRoot: h.packagesRoot,

        lifecycle,
        reconcileConfiguration: async () =>
          h.store.transaction((tx) => {
            const i = tx.instances.get(first.pluginInstanceId);
            tx.instances.put({ ...i, lifecycleRevision: i.lifecycleRevision + 1 });
          }),
      });
      await writeLocalPackage(directory, manifest({ version: '0.1.0-alpha.2' }), '// broken replacement');
      await assert.rejects(
        admission.install({ kind: 'local-directory', path: directory }),
        (error) => error.code === (failOld ? 'UPDATE_ROLLBACK_RESUME_FAILED' : 'UPDATE_RESUME_FAILED'),
      );
      const after = await h.store.snapshot();
      const restored = after.instances[0];
      assert.equal(restored.packageDigest, first.packageDigest);
      assert.equal(restored.pluginInstanceId, first.pluginInstanceId);
      assert.equal(restored.configReadiness, before.instances[0].configReadiness);
      assert.equal(restored.activationState, 'enabled');
      assert.equal(restored.runtimeState, failOld ? 'crashed' : 'healthy');
      assert.ok(restored.lifecycleRevision > before.instances[0].lifecycleRevision);
      assert.equal(await readFile(retained, 'utf8'), 'owner settings and retained data');
      assert.equal(starts.length, 2);
      assert.notEqual(starts[0], first.packageDigest);
      assert.equal(starts[1], first.packageDigest);
      assert.deepEqual(
        reports.map((r) => r.phase),
        failOld ? ['maintenance_resume', 'maintenance_rollback_resume'] : ['maintenance_resume'],
      );
      if (failOld) assert.equal(restored.lastRuntimeError.code, 'UPDATE_ROLLBACK_RESUME_FAILED');
    });
  }
}

for (const enabled of [false, true]) {
  test(`failed configuration reconciliation rolls back admitted package and readiness (enabled: ${enabled})`, async () => {
    const directory = await tempRoot('cat-cafe-rollback-readiness-');
    await writeLocalPackage(directory);
    const h = await harness();
    const first = await h.admission.install({ kind: 'local-directory', path: directory });
    await h.store.transaction((tx) =>
      tx.instances.put({
        ...tx.instances.get(first.pluginInstanceId),
        activationState: enabled ? 'enabled' : 'disabled',
        runtimeState: enabled ? 'healthy' : 'stopped',
        configReadiness: 'ready',
      }),
    );
    const starts = [];
    const lifecycle = new ExternalPluginLifecycleService({
      store: h.store,
      supervisor: {
        stop: async () => {},
        start: async () => starts.push((await h.store.snapshot()).instances[0].packageDigest),
      },
    });
    const admission = new LocalPluginPackageAdmission({
      inventory: h.inventory,
      packagesRoot: h.packagesRoot,

      ...(enabled ? { lifecycle } : {}),
      reconcileConfiguration: async () => {
        await h.store.transaction((tx) => {
          const i = tx.instances.get(first.pluginInstanceId);
          tx.instances.put({ ...i, configReadiness: 'incomplete', lifecycleRevision: i.lifecycleRevision + 1 });
        });
        throw new Error('fixture reconciliation failed');
      },
    });
    await writeFile(join(directory, 'dist/entrypoint.js'), '// replacement');
    await assert.rejects(
      admission.install({ kind: 'local-directory', path: directory }),
      /fixture reconciliation failed/,
    );
    const after = await h.store.snapshot();
    assert.equal(after.instances[0].packageDigest, first.packageDigest);
    assert.equal(after.instances[0].configReadiness, 'ready');
    assert.equal(after.instances[0].activationState, enabled ? 'enabled' : 'disabled');
    assert.deepEqual(starts, enabled ? [first.packageDigest] : []);
  });
}

async function archiveSource(entrypoint, packageName = '@clowder-ai/official-test-source') {
  const archive = await packageArchive({
    extraFiles: {
      'dist/entrypoint.js': entrypoint,
      'package.json': JSON.stringify({ name: packageName, version: '0.1.0-alpha.1', type: 'module' }),
    },
  });
  const path = join(await tempRoot('cat-cafe-local-archive-update-'), 'package.tgz');
  await writeFile(path, archive.bytes);
  return { kind: 'local-archive', path };
}

test('archive reselection preserves the instance, old package and retained data', async () => {
  const { admission, store, packagesRoot } = await harness();
  const first = await admission.install(await archiveSource('// first'));
  const dataFile = join(packagesRoot, 'retained-owner-data');
  await writeFile(dataFile, 'retained');
  const before = await store.snapshot();
  const updated = await admission.install(await archiveSource('// updated'));
  const after = await store.snapshot();
  assert.equal(updated.pluginInstanceId, first.pluginInstanceId);
  assert.notEqual(updated.packageDigest, first.packageDigest);
  assert.equal(after.instances.length, 1);
  assert.equal(after.instances[0].installedAt, before.instances[0].installedAt);
  assert.equal(after.instances[0].lifecycleRevision, before.instances[0].lifecycleRevision + 1);
  await access(join(packagesRoot, packageDirectoryName(first.packageDigest), 'package.tgz'));
  assert.equal(await readFile(dataFile, 'utf8'), 'retained');
});

test('archive reselection refuses a running instance without changing inventory', async () => {
  const { admission, store } = await harness();
  const first = await admission.install(await archiveSource('// first'));
  await store.transaction((tx) =>
    tx.instances.put({
      ...tx.instances.get(first.pluginInstanceId),
      runtimeState: 'healthy',
      activationState: 'enabled',
    }),
  );
  const before = await store.snapshot();
  await assert.rejects(
    admission.install(await archiveSource('// updated')),
    (error) => error.code === 'INVENTORY_REJECTED' && error.cause?.code === 'RUNTIME_NOT_STOPPED',
  );
  assert.deepEqual(await store.snapshot(), before);
});

test('archive reselection cannot switch package identity or source kind', async () => {
  const { admission, store } = await harness();
  await admission.install(await archiveSource('// first'));
  const before = await store.snapshot();
  await assert.rejects(admission.install(await archiveSource('// other', '@clowder-ai/other-package')), {
    code: 'INVENTORY_REJECTED',
  });
  assert.deepEqual(await store.snapshot(), before);
  const h = await harness();
  const directory = await tempRoot('cat-cafe-local-directory-origin-');
  await writeLocalPackage(directory);
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@clowder-ai/official-test-source', version: '0.1.0-alpha.1' }),
  );
  await h.admission.install({ kind: 'local-directory', path: directory });
  const directoryBefore = await h.store.snapshot();
  await assert.rejects(h.admission.install(await archiveSource('// updated')), { code: 'INVENTORY_REJECTED' });
  assert.deepEqual(await h.store.snapshot(), directoryBefore);
});
