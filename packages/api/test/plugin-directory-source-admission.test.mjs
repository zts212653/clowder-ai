import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { FilesystemVerifiedPluginPackageLocator } from '../src/domains/plugin/external-runtime/filesystem-package-locator.ts';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.ts';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.ts';
import { inspectLocalDirectorySource } from '../src/domains/plugin/manager/local-directory-source.ts';
import { LocalPluginPackageAdmission } from '../src/domains/plugin/manager/local-package-admission.ts';
import { manifest } from './plugin-official-package-installer.fixture.js';

async function json(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(
  t,
  { observed = '1.0.0', lockSpecifier = '1.0.0', lockVersion = '9.0', missingLock = false } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-directory-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'packages/plugin');
  const runtime = join(root, 'packages/runtime');
  const inventoryRoot = join(root, 'inventory');
  await mkdir(join(source, 'node_modules'), { recursive: true });
  await mkdir(join(source, 'dist'));
  await mkdir(join(source, 'schemas'));
  await mkdir(join(runtime, 'dist'), { recursive: true });
  await json(join(root, 'package.json'), { name: 'source-workspace', private: true, packageManager: 'pnpm@9.15.4' });
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  await json(join(source, 'package.json'), {
    name: 'directory-test-plugin',
    version: '0.1.0-alpha.1',
    type: 'module',
    main: './dist/entrypoint.js',
    files: ['dist', 'manifest.json', 'schemas'],
    dependencies: { 'runtime-dependency': '1.0.0' },
    scripts: { prepack: "node -e \"require('node:fs').writeFileSync('script-ran','bad')\"" },
  });
  await json(join(runtime, 'package.json'), {
    name: 'runtime-dependency',
    version: observed,
    type: 'module',
    main: './dist/index.js',
    files: ['dist'],
  });
  await writeFile(join(runtime, 'dist/index.js'), 'export const value = 42;\n');
  await writeFile(join(source, 'dist/entrypoint.js'), 'export { value } from "runtime-dependency";\n');
  await json(join(source, 'manifest.json'), manifest());
  await json(join(source, 'schemas/official.test.v1.schema.json'), {
    type: 'object',
    properties: { payload: { type: 'object' }, source: { type: 'object' } },
    required: ['payload', 'source'],
  });
  await symlink(runtime, join(source, 'node_modules/runtime-dependency'), 'dir');
  if (!missingLock)
    await writeFile(
      join(root, 'pnpm-lock.yaml'),
      stringify({
        lockfileVersion: lockVersion,
        importers: {
          '.': {},
          'packages/plugin': {
            dependencies: { 'runtime-dependency': { specifier: lockSpecifier, version: 'link:../runtime' } },
          },
          'packages/runtime': {},
        },
        packages: {},
        snapshots: {},
      }),
    );
  const packMarker = join(root, 'pack-called');
  const packSentinel = join(root, 'npm-sentinel');
  await writeFile(packSentinel, `#!/bin/sh\nprintf called > '${packMarker}'\nexit 71\n`);
  await chmod(packSentinel, 0o700);
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_source', now: () => 1000 });
  const createAdmission = (npmBin = packSentinel) =>
    new LocalPluginPackageAdmission({
      inventory,
      packagesRoot: inventoryRoot,
      npmBin,
    });
  return { root, source, inventoryRoot, store, packMarker, createAdmission };
}

async function rejectsBeforePreparation(f, reason) {
  let failure;
  try {
    await f.createAdmission().install({ kind: 'local-directory', path: f.source });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${reason}: inconsistent source graph must be rejected before preparation`);
  // Keep the existing public admission envelope; the machine reason belongs to the internal preparation boundary.
  assert.equal(failure.code, 'INVALID_LOCAL_SOURCE');
  assert.equal(failure.cause?.code, reason);
  assert.deepEqual((await f.store.snapshot()).instances, []);
  assert.deepEqual((await f.store.snapshot()).packages, []);
  await assert.rejects(access(f.packMarker), { code: 'ENOENT' }, 'source refusal must precede npm pack');
}

test('refuses declared exact version versus physical workspace dependency mismatch before pack or inventory', async (t) => {
  await rejectsBeforePreparation(await fixture(t, { observed: '2.0.0' }), 'DEPENDENCY_VERSION_MISMATCH');
});

test('accepts a prefixed workspace dependency version without rewriting its observed identity', async (t) => {
  const f = await fixture(t, { observed: 'v1.0.0' });
  const source = await inspectLocalDirectorySource(f.source);
  assert.equal(source.dependencies[0].observedVersion, 'v1.0.0');
  await source.assertCurrent();
});

async function registryVersionFixture(t, { requested, observed, locked = '2.1.6-beta.1' }) {
  const f = await fixture(t, { observed });
  const metadata = JSON.parse(await readFile(join(f.source, 'package.json'), 'utf8'));
  metadata.dependencies['runtime-dependency'] = requested;
  await json(join(f.source, 'package.json'), metadata);
  const coordinate = `runtime-dependency@${locked}`;
  await writeFile(
    join(f.root, 'pnpm-lock.yaml'),
    stringify({
      lockfileVersion: '9.0',
      importers: {
        '.': {},
        'packages/plugin': { dependencies: { 'runtime-dependency': { specifier: requested, version: locked } } },
      },
      packages: { [coordinate]: { resolution: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } } },
      snapshots: { [coordinate]: {} },
    }),
  );
  return f;
}

test('accepts prefixed registry versions for exact and range declarations while retaining lock coordinates', async (t) => {
  for (const requested of ['2.1.6-beta.1', '^2.1.6-beta.1']) {
    const f = await registryVersionFixture(t, { requested, observed: 'v2.1.6-beta.1' });
    const source = await inspectLocalDirectorySource(f.source);
    assert.equal(source.dependencies[0].observedVersion, 'v2.1.6-beta.1');
    assert.equal(source.dependencies[0].lockCoordinate, '2.1.6-beta.1');
    await source.assertCurrent();
    assert.equal(
      JSON.parse(await readFile(join(f.root, 'packages/runtime/package.json'), 'utf8')).version,
      'v2.1.6-beta.1',
    );
  }
});

test('prefix normalization still refuses version, prerelease, build and locked resolution mismatches', async (t) => {
  for (const observed of ['v2.1.7-beta.1', 'v2.1.6-beta.2', 'v2.1.6-beta.1+other', 'vv2.1.6-beta.1']) {
    const f = await registryVersionFixture(t, { requested: '2.1.6-beta.1', observed });
    await rejectsBeforePreparation(f, 'DEPENDENCY_VERSION_MISMATCH');
  }
  for (const observed of ['v2.1.6-beta.2', 'v2.1.6-beta.1+other']) {
    const f = await registryVersionFixture(t, { requested: '^2.1.6-beta.1', observed });
    await rejectsBeforePreparation(f, 'DEPENDENCY_LOCK_MISMATCH');
  }
});

test('refuses a lock importer specifier inconsistent with the selected package before pack or inventory', async (t) => {
  await rejectsBeforePreparation(await fixture(t, { lockSpecifier: '2.0.0' }), 'DEPENDENCY_LOCK_MISMATCH');
});

test('refuses a runtime dependency graph without a source-owned lock before pack or inventory', async (t) => {
  await rejectsBeforePreparation(await fixture(t, { missingLock: true }), 'DEPENDENCY_LOCK_MISSING');
});

test('refuses an unsupported lock format instead of copying the physical graph as proof', async (t) => {
  await rejectsBeforePreparation(await fixture(t, { lockVersion: '8.0' }), 'DEPENDENCY_LOCK_UNSUPPORTED');
});

test('installs publication members and workspace runtime closure without dev files or pack scripts', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'test'));
  const large = await open(join(f.source, 'test/unpublished.bin'), 'wx');
  try {
    await large.truncate(33 * 1024 * 1024);
  } finally {
    await large.close();
  }
  const result = await f.createAdmission('npm').install({ kind: 'local-directory', path: f.source });
  assert.equal(result.pluginInstanceId, 'pi_source');
  assert.equal((await f.store.snapshot()).packages[0].provenance.dependencyClosure, 'shipped');
  const locator = new FilesystemVerifiedPluginPackageLocator(f.inventoryRoot);
  const located = await locator.resolveInstalledPackage(result.packageDigest);
  try {
    assert.match(await readFile(join(located.rootDir, 'dist/entrypoint.js'), 'utf8'), /runtime-dependency/);
    assert.match(await readFile(join(located.rootDir, 'node_modules/runtime-dependency/dist/index.js'), 'utf8'), /42/);
    await assert.rejects(access(join(located.rootDir, 'test/unpublished.bin')), { code: 'ENOENT' });
    await assert.rejects(access(join(f.source, 'script-ran')), { code: 'ENOENT' });
    const receipt = JSON.parse(await readFile(join(located.rootDir, '.clowder-local-source.json'), 'utf8'));
    assert.equal(receipt.provenance, 'owner-local');
    assert.equal(receipt.nodes.length, 2);
    assert.match(receipt.sourceGraphDigest, /^sha512-/);
    assert.equal(
      receipt.nodes.some((node) => node.members.some((member) => member.path === 'test/unpublished.bin')),
      false,
    );
    await rename(f.source, `${f.source}-moved`);
    await rename(join(f.root, 'packages/runtime'), join(f.root, 'packages/runtime-moved'));
    // This is only the fresh fixture's inert export, never a real plugin entrypoint.
    assert.equal((await import(pathToFileURL(join(located.rootDir, 'dist/entrypoint.js')).href)).value, 42);
    assert.equal(
      (await readdir(f.inventoryRoot)).some((name) => name.startsWith('.directory-prepare-')),
      false,
    );
    await located.verifyIntegrity();
  } finally {
    await located.release();
  }
});

test('keeps dependency-free ordinary local directories admissible', async (t) => {
  const f = await fixture(t);
  // This independent root has no dependencies and needs no workspace resolution.
  const ordinary = join(f.root, 'ordinary');
  await mkdir(join(ordinary, 'dist'), { recursive: true });
  await mkdir(join(ordinary, 'schemas'));
  await json(join(ordinary, 'package.json'), {
    name: 'directory-test-plugin',
    version: '0.1.0-alpha.1',
    type: 'module',
    files: ['dist', 'schemas', 'manifest.json'],
  });
  await json(join(ordinary, 'manifest.json'), manifest());
  await writeFile(join(ordinary, 'dist/entrypoint.js'), '// no side effects\n');
  await json(join(ordinary, 'schemas/official.test.v1.schema.json'), {
    type: 'object',
    properties: { payload: { type: 'object' }, source: { type: 'object' } },
    required: ['payload', 'source'],
  });
  const result = await f.createAdmission('npm').install({ kind: 'local-directory', path: ordinary });
  assert.equal(result.pluginId, 'official.test-source');
  assert.equal((await f.store.snapshot()).instances.length, 1);
});

test('stops source inspection when the caller aborts during filesystem traversal', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('inspection cancelled by caller');
  const pending = inspectLocalDirectorySource(f.source, { signal: controller.signal });
  // Inspection already started and yielded for real filesystem IO. Do not
  // mutate or replace the filesystem implementation to make cancellation pass.
  const immediate = setImmediate(() => controller.abort(reason));
  t.after(() => clearImmediate(immediate));
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(controller.signal.aborted, true);
  await assert.rejects(access(f.packMarker), { code: 'ENOENT' });
});

test('stops the shared source read-set revalidation after caller cancellation', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const source = await inspectLocalDirectorySource(f.source, { signal: controller.signal });
  const reason = new Error('source revalidation cancelled by caller');
  controller.abort(reason);
  await assert.rejects(source.assertCurrent(), (error) => error === reason);
});

test('bounds total repeated dependency edges before npm or inventory', { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  const names = Array.from({ length: 65 }, (_, i) => `dense-node-${i}`);
  const importers = { '.': {}, 'packages/plugin': { dependencies: {} } };
  const rootMetadata = JSON.parse(await readFile(join(f.source, 'package.json'), 'utf8'));
  rootMetadata.dependencies = Object.fromEntries(names.map((name) => [name, '1.0.0']));
  await mkdir(join(f.root, 'node_modules'));
  for (const name of names) {
    const nodeRoot = join(f.root, 'packages', name);
    await mkdir(nodeRoot);
    const dependencies = Object.fromEntries(names.filter((other) => other !== name).map((other) => [other, '1.0.0']));
    await json(join(nodeRoot, 'package.json'), { name, version: '1.0.0', dependencies });
    importers[`packages/${name}`] = {
      dependencies: Object.fromEntries(
        Object.keys(dependencies).map((other) => [other, { specifier: '1.0.0', version: `link:../${other}` }]),
      ),
    };
    importers['packages/plugin'].dependencies[name] = { specifier: '1.0.0', version: `link:../${name}` };
    await symlink(nodeRoot, join(f.root, 'node_modules', name), 'dir');
  }
  await json(join(f.source, 'package.json'), rootMetadata);
  await writeFile(
    join(f.root, 'pnpm-lock.yaml'),
    stringify({ lockfileVersion: '9.0', importers, packages: {}, snapshots: {} }),
  );
  // Each node has fewer than 512 edges, but the graph has 4,225 declarations.
  // They are repeated references, not 4,225 unique physical package nodes.
  await rejectsBeforePreparation(f, 'DEPENDENCY_PREPARATION_LIMIT');
});

test('cancels and releases staging while copying a directory without package.json', async (t) => {
  const f = await fixture(t);
  const source = join(f.root, 'plain');
  await mkdir(join(source, 'schemas'), { recursive: true });
  await mkdir(join(source, 'dist'));
  await json(join(source, 'manifest.json'), manifest());
  await json(join(source, 'schemas/official.test.v1.schema.json'), {
    type: 'object',
    properties: { payload: { type: 'object' }, source: { type: 'object' } },
    required: ['payload', 'source'],
  });
  await writeFile(join(source, 'dist/entrypoint.js'), '// inert\n');
  for (let i = 0; i < 200; i++) await writeFile(join(source, `file-${i}.txt`), 'x'.repeat(1024));
  const controller = new AbortController();
  const reason = new Error('plain directory copy cancelled');
  let stageSeen = false;
  let observing = false;
  let observationError;
  const timer = setInterval(async () => {
    if (observing || stageSeen) return;
    observing = true;
    try {
      const entries = await readdir(f.inventoryRoot).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      if (entries.some((entry) => entry.startsWith('.local-directory-'))) {
        stageSeen = true;
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
      f.createAdmission().install({ kind: 'local-directory', path: source }, { signal: controller.signal }),
      (error) => error === reason || error.cause === reason,
    );
    assert.equal(observationError, undefined);
    assert.equal(stageSeen, true, 'cancel only after actual staging starts');
    for (const key of ['instances', 'packages']) assert.deepEqual((await f.store.snapshot())[key], []);
    assert.equal(
      (await readdir(f.inventoryRoot)).some((entry) => entry.startsWith('.local-directory-')),
      false,
    );
    await assert.rejects(access(f.packMarker), { code: 'ENOENT' });
  } finally {
    clearInterval(timer);
  }
});

test('installs a CommonJS dependency with an extensionless main using its published entry', async (t) => {
  const f = await fixture(t);
  const runtime = join(f.root, 'packages/runtime');
  const metadata = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  await json(join(runtime, 'package.json'), { ...metadata, type: 'commonjs', main: './dist/index' });
  await writeFile(join(runtime, 'dist/index.js'), 'exports.value = 42;\n');
  const installed = await f.createAdmission('npm').install({ kind: 'local-directory', path: f.source });
  const located = await new FilesystemVerifiedPluginPackageLocator(f.inventoryRoot).resolveInstalledPackage(
    installed.packageDigest,
  );
  try {
    await rename(f.source, `${f.source}-moved`);
    await rename(runtime, `${runtime}-moved`);
    assert.equal((await import(pathToFileURL(join(located.rootDir, 'dist/entrypoint.js')).href)).value, 42);
    await located.verifyIntegrity();
  } finally {
    await located.release();
  }
});

test('does not admit missing or escaping dependency mains', async (t) => {
  for (const main of ['./dist/missing', '../outside.js']) {
    const f = await fixture(t);
    const runtime = join(f.root, 'packages/runtime');
    const metadata = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
    await json(join(runtime, 'package.json'), { ...metadata, main });
    await assert.rejects(
      () => f.createAdmission('npm').install({ kind: 'local-directory', path: f.source }),
      (error) => error.code === 'INVALID_LOCAL_SOURCE' && error.cause?.code === 'DEPENDENCY_SOURCE_INVALID',
    );
    assert.deepEqual((await f.store.snapshot()).instances, []);
  }
});

test('uses exports instead of a stale legacy main in an installed dependency', async (t) => {
  const f = await fixture(t);
  const runtime = join(f.root, 'packages/runtime');
  const metadata = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  await json(join(runtime, 'package.json'), {
    ...metadata,
    main: './dist/absent.js',
    exports: { '.': { import: './dist/index.js' } },
  });
  const installed = await f.createAdmission('npm').install({ kind: 'local-directory', path: f.source });
  const located = await new FilesystemVerifiedPluginPackageLocator(f.inventoryRoot).resolveInstalledPackage(
    installed.packageDigest,
  );
  try {
    await rename(f.source, `${f.source}-moved`);
    await rename(runtime, `${runtime}-moved`);
    assert.equal((await import(pathToFileURL(join(located.rootDir, 'dist/entrypoint.js')).href)).value, 42);
    await located.verifyIntegrity();
  } finally {
    await located.release();
  }
});

test('admits a type-only dependency with an empty main', async (t) => {
  const f = await fixture(t);
  const runtime = join(f.root, 'packages/runtime');
  const metadata = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  await json(join(runtime, 'package.json'), { ...metadata, main: '', types: './dist/index.d.ts' });
  await rm(join(runtime, 'dist/index.js'));
  await writeFile(join(runtime, 'dist/index.d.ts'), 'export declare const value: number;\n');
  await writeFile(join(f.source, 'dist/entrypoint.js'), 'export const value = 42;\n');
  const installed = await f.createAdmission('npm').install({ kind: 'local-directory', path: f.source });
  assert.ok(installed.packageDigest);
});

test('preserves published nested node_modules fixtures without treating them as root dependencies', async (t) => {
  const f = await fixture(t);
  const runtime = join(f.root, 'packages/runtime');
  const metadata = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  await json(join(runtime, 'package.json'), { ...metadata, files: ['dist', 'test'] });
  const member = 'test/fixtures/eval/node_modules/file1.js';
  await mkdir(join(runtime, 'test/fixtures/eval/node_modules'), { recursive: true });
  await writeFile(join(runtime, member), 'module.exports = 17;\n');
  const installed = await f.createAdmission('npm').install({ kind: 'local-directory', path: f.source });
  const located = await new FilesystemVerifiedPluginPackageLocator(f.inventoryRoot).resolveInstalledPackage(
    installed.packageDigest,
  );
  try {
    await rename(f.source, `${f.source}-moved`);
    await rename(runtime, `${runtime}-moved`);
    assert.equal(
      await readFile(join(located.rootDir, 'node_modules/runtime-dependency', member), 'utf8'),
      'module.exports = 17;\n',
    );
    assert.equal((await import(pathToFileURL(join(located.rootDir, 'dist/entrypoint.js')).href)).value, 42);
    await located.verifyIntegrity();
  } finally {
    await located.release();
  }
});
