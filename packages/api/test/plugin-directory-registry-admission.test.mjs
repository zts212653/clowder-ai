import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { stringify } from 'yaml';
import {
  FilesystemVerifiedPluginPackageLocator,
  packageDirectoryName,
} from '../src/domains/plugin/external-runtime/filesystem-package-locator.ts';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.ts';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.ts';
import { LocalPluginPackageAdmission } from '../src/domains/plugin/manager/local-package-admission.ts';
import { publishPluginPackageArchive } from '../src/domains/plugin/official-package-archive.ts';
import { manifest } from './plugin-official-package-installer.fixture.js';

const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const json = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);

// Synthetic lock-declared registry bytes. Owner-provided content is a separate
// source of authority; these cached bytes must not govern local admission.
function archive(files) {
  const entries = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`);
    const octal = (n, offset, width) =>
      header.write(`${n.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'ascii');
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(body.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((a, b) => a + b, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    entries.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

async function fixture(
  t,
  {
    requested = '1.2.3',
    observed = '1.2.3',
    transitive = false,
    peer = false,
    optional = false,
    seed = false,
    cycle = false,
    multipleVersions = false,
    shadowOptional = false,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'directory-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const physical = join(root, 'physical');
  const packagesRoot = join(root, 'admitted');
  await mkdir(join(source, 'node_modules'), { recursive: true });
  await mkdir(join(source, 'dist'));
  await mkdir(join(source, 'schemas'));
  await mkdir(physical);
  const alpha = {
    name: 'registry-dependency',
    version: observed,
    type: 'module',
    main: './dist/index.js',
    files: ['dist'],
  };
  if (transitive) alpha.dependencies = { 'registry-leaf': '^2.0.0' };
  if (shadowOptional) alpha.optionalDependencies = { 'registry-leaf': '^2.0.0' };
  if (peer) alpha.peerDependencies = { 'registry-peer': '^3.0.0' };
  const definitions = [
    {
      metadata: alpha,
      body: transitive
        ? 'export { value } from "registry-leaf";\n'
        : peer
          ? 'export { value } from "registry-peer";\n'
          : 'export const value = 42;\n',
    },
  ];
  if (transitive || shadowOptional)
    definitions.push({
      metadata: {
        name: 'registry-leaf',
        version: '2.1.0',
        type: 'module',
        main: './dist/index.js',
        ...(cycle ? { dependencies: { 'registry-dependency': '1.2.3' } } : {}),
      },
      body: `${cycle ? 'import "registry-dependency";\n' : ''}export const value = 42;\n`,
    });
  if (multipleVersions)
    definitions.push({
      key: 'registry-leaf-old',
      metadata: { name: 'registry-leaf', version: '1.1.0', type: 'module', main: './dist/index.js' },
      body: 'export const value = 13;\n',
    });
  if (peer)
    definitions.push({
      metadata: { name: 'registry-peer', version: '3.0.0', type: 'module', main: './dist/index.js' },
      body: 'export const value = 42;\n',
    });
  const nodes = new Map();
  const packages = {};
  const snapshots = {};
  for (const definition of definitions) {
    const metadata = definition.metadata;
    const key = definition.key ?? metadata.name;
    const directory = join(physical, key);
    const files = {
      'package.json': `${JSON.stringify(metadata)}\n`,
      'dist/index.js': definition.body,
      'dist/index.d.ts': 'export declare const value: number;\n',
    };
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), body, { mode: 0o644 });
    }
    const bytes = archive(files);
    const sri = integrity(bytes);
    nodes.set(key, { ...definition, directory, bytes, sri });
    packages[`${metadata.name}@${metadata.version}`] = { resolution: { integrity: sri } };
    snapshots[`${metadata.name}@${metadata.version}`] = {};
    if (seed) await publishPluginPackageArchive(packagesRoot, sri, bytes);
  }
  const alphaCoordinate = `${observed}${peer ? '(registry-peer@3.0.0)' : ''}`;
  if (peer) {
    delete snapshots[`registry-dependency@${observed}`];
    snapshots[`registry-dependency@${alphaCoordinate}`] = { dependencies: { 'registry-peer': '3.0.0' } };
  }
  if (transitive) snapshots[`registry-dependency@${observed}`] = { dependencies: { 'registry-leaf': '2.1.0' } };
  if (cycle) snapshots['registry-leaf@2.1.0'] = { dependencies: { 'registry-dependency': '1.2.3' } };
  if (shadowOptional)
    snapshots[`registry-dependency@${observed}`] = { optionalDependencies: { 'registry-leaf': '2.1.0' } };
  for (const node of nodes.values()) {
    await mkdir(join(node.directory, 'node_modules'));
    for (const name of Object.keys({ ...node.metadata.dependencies, ...node.metadata.peerDependencies })) {
      await symlink(nodes.get(name).directory, join(node.directory, 'node_modules', name), 'dir');
    }
  }
  const rootLeafVersion = multipleVersions ? '1.1.0' : shadowOptional ? '2.1.0' : undefined;
  const dependencies = {
    'registry-dependency': requested,
    ...(peer ? { 'registry-peer': '3.0.0' } : {}),
    ...(rootLeafVersion ? { 'registry-leaf': rootLeafVersion } : {}),
  };
  const importer = {
    dependencies: {
      'registry-dependency': { specifier: requested, version: alphaCoordinate },
      ...(peer ? { 'registry-peer': { specifier: '3.0.0', version: '3.0.0' } } : {}),
      ...(rootLeafVersion ? { 'registry-leaf': { specifier: rootLeafVersion, version: rootLeafVersion } } : {}),
    },
  };
  const sourceMetadata = {
    name: 'directory-registry-plugin',
    version: '1.0.0',
    type: 'module',
    main: './dist/entrypoint.js',
    files: ['dist', 'schemas', 'manifest.json'],
    dependencies,
  };
  if (optional) {
    sourceMetadata.optionalDependencies = { 'absent-platform-helper': '1.0.0' };
    importer.optionalDependencies = { 'absent-platform-helper': { specifier: '1.0.0', version: '1.0.0' } };
    packages['absent-platform-helper@1.0.0'] = { resolution: { integrity: integrity(Buffer.from('not selected')) } };
    snapshots['absent-platform-helper@1.0.0'] = {};
  }
  for (const name of Object.keys(dependencies))
    await symlink(
      nodes.get(multipleVersions && name === 'registry-leaf' ? 'registry-leaf-old' : name).directory,
      join(source, 'node_modules', name),
      'dir',
    );
  const lock = { lockfileVersion: '9.0', importers: { '.': importer }, packages, snapshots };
  await json(join(source, 'package.json'), sourceMetadata);
  await writeFile(join(source, 'pnpm-lock.yaml'), stringify(lock));
  await writeFile(
    join(source, 'dist/entrypoint.js'),
    `export { value } from "registry-dependency";\n${multipleVersions ? 'export { value as older } from "registry-leaf";\n' : ''}`,
  );
  await json(join(source, 'manifest.json'), manifest());
  await json(join(source, 'schemas/official.test.v1.schema.json'), {
    type: 'object',
    properties: { payload: { type: 'object' }, source: { type: 'object' } },
    required: ['payload', 'source'],
  });
  const marker = join(root, 'npm-called');
  const sentinel = join(root, 'npm-sentinel');
  await writeFile(sentinel, `#!/bin/sh\nprintf called > '${marker}'\nexit 71\n`);
  await chmod(sentinel, 0o700);
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_registry', now: () => 1 });
  let grants = 0;
  const admission = (npmBin = 'npm') =>
    new LocalPluginPackageAdmission({
      inventory,
      packagesRoot,
      npmBin,
      grantPolicy: () => {
        grants++;
        return ['messaging.send'];
      },
    });
  return {
    root,
    multipleVersions,
    source,
    physical,
    packagesRoot,
    nodes,
    lock,
    store,
    admission,
    marker,
    sentinel,
    grants: () => grants,
  };
}

async function reject(f, code) {
  await assert.rejects(f.admission(f.sentinel).install({ kind: 'local-directory', path: f.source }), (error) => {
    assert.equal(error.code, 'INVALID_LOCAL_SOURCE');
    assert.equal(error.cause?.code, code);
    return true;
  });
  assert.equal(f.grants(), 0);
  for (const key of ['instances', 'packages', 'grants']) assert.deepEqual((await f.store.snapshot())[key], []);
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
}

async function installed(f, expectedValue = 42) {
  const result = await f.admission().install({ kind: 'local-directory', path: f.source });
  const locator = new FilesystemVerifiedPluginPackageLocator(f.packagesRoot);
  const located = await locator.resolveInstalledPackage(result.packageDigest);
  try {
    await rename(f.source, `${f.source}-moved`);
    await rename(f.physical, `${f.physical}-moved`);
    const loaded = await import(pathToFileURL(join(located.rootDir, 'dist/entrypoint.js')).href);
    assert.equal(loaded.value, expectedValue);
    if (f.multipleVersions) assert.equal(loaded.older, 13);
    const receipt = JSON.parse(await readFile(join(located.rootDir, '.clowder-local-source.json'), 'utf8'));
    assert.equal(receipt.version, 2);
    assert.equal(receipt.contentProvenance, 'owner-local');
    for (const entry of receipt.nodes) {
      assert.equal(entry.contentProvenance, 'owner-local');
      assert.equal(Object.hasOwn(entry, 'registryIntegrity'), false);
      assert.match(entry.packDigest, /^sha512-/);
    }
    for (const node of f.nodes.values()) {
      const entry = receipt.nodes.find(
        (entry) => entry.name === node.metadata.name && entry.version === node.metadata.version,
      );
      assert.ok(entry);
      assert.equal(entry.lockIntegrity, node.sri);
      assert.notEqual(entry.packDigest, node.sri, 'local pack digest must not impersonate the original registry SRI');
    }
    const record = (await f.store.snapshot()).packages[0];
    assert.equal(record.provenance.kind, 'local-directory');
    assert.equal(record.provenance.dependencyClosure, 'shipped');
    await located.verifyIntegrity();
  } finally {
    await located.release();
  }
}

test('seals owner-local bytes without claiming cached registry provenance', async (t) => {
  await installed(await fixture(t, { requested: '^1.0.0', transitive: true, seed: true }));
});

test('admits an owner-local closure with an empty canonical archive cache', async (t) => {
  await installed(await fixture(t));
});

test('does not consult unrelated canonical cache bytes for owner-local admission', async (t) => {
  const f = await fixture(t, { seed: true });
  const alpha = f.nodes.get('registry-dependency');
  const corrupted = Buffer.from(alpha.bytes);
  corrupted[corrupted.length - 1] ^= 1;
  await writeFile(join(f.packagesRoot, packageDirectoryName(alpha.sri), 'package.tgz'), corrupted);
  await installed(f);
});

test('seals locally modified dependency bytes without claiming registry integrity', async (t) => {
  const f = await fixture(t, { seed: true });
  await writeFile(join(f.nodes.get('registry-dependency').directory, 'dist/index.js'), 'export const value = 99;\n');
  await installed(f, 99);
});

test('refuses a transitive snapshot selecting another physical dependency version', async (t) => {
  const f = await fixture(t, { transitive: true });
  f.lock.snapshots['registry-dependency@1.2.3'].dependencies['registry-leaf'] = '2.2.0';
  await writeFile(join(f.source, 'pnpm-lock.yaml'), stringify(f.lock));
  await reject(f, 'DEPENDENCY_LOCK_MISMATCH');
});

test('admits a peer-bound lock coordinate and preserves runtime ancestor resolution', async (t) => {
  await installed(await fixture(t, { peer: true }));
});

test('refuses a prerelease excluded by normal semver range semantics', async (t) => {
  await reject(await fixture(t, { requested: '^1.0.0', observed: '1.3.0-beta.1' }), 'DEPENDENCY_VERSION_MISMATCH');
});

test('records absent declared optional dependency without inventing bytes or loading it', async (t) => {
  await installed(await fixture(t, { optional: true }));
});

test('preserves a cyclic registry graph after the physical source is removed', async (t) => {
  await installed(await fixture(t, { transitive: true, cycle: true }));
});

test('preserves separate versions in the root and transitive consumer scopes', async (t) => {
  await installed(await fixture(t, { transitive: true, multipleVersions: true }));
});

test('refuses relocation that makes an absent optional dependency visible from an ancestor', async (t) => {
  const f = await fixture(t, { shadowOptional: true, seed: true });
  // Alpha's physical tree cannot see the root's leaf; relocation must not turn
  // this attested absence into a present optional dependency.
  await assert.rejects(access(join(f.nodes.get('registry-dependency').directory, 'node_modules/registry-leaf')), {
    code: 'ENOENT',
  });
  await assert.rejects(f.admission().install({ kind: 'local-directory', path: f.source }), (error) => {
    assert.equal(error.code, 'INVALID_LOCAL_SOURCE');
    assert.equal(error.cause?.code, 'DEPENDENCY_LOCK_MISMATCH');
    return true;
  });
  assert.equal(f.grants(), 0);
  for (const key of ['instances', 'packages', 'grants']) assert.deepEqual((await f.store.snapshot())[key], []);
});
