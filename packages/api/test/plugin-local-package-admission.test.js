import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  FilePluginPackageQuarantineStore,
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
  packageDirectoryName,
} from '../dist/domains/plugin/index.js';
import { manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

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

async function harness({ quarantine = false, grantPolicy } = {}) {
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
    grantPolicy:
      grantPolicy ??
      (async (packageManifest) => packageManifest.features.flatMap((feature) => [...feature.capabilities])),
    ...(quarantineStore ? { quarantine: quarantineStore } : {}),
  });
  return { admission, inventory, packagesRoot, store, quarantines: quarantineStore };
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
    packageManifest: manifest(),
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
  assert.deepEqual(snapshot.grants[0].effectiveGrants, ['events.publish']);
  assert.equal(snapshot.packages[0].packageState, 'installed');
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

test('quarantines a local package rejected by Host grant admission', async () => {
  const archive = await packageArchive();
  const archivePath = join(await tempRoot('cat-cafe-f202-local-invalid-grant-'), 'plugin.tgz');
  await writeFile(archivePath, archive.bytes);
  const { admission, store, quarantines } = await harness({
    quarantine: true,
    grantPolicy: async () => ['secret.read'],
  });

  await assert.rejects(
    admission.install({ kind: 'local-archive', path: archivePath }),
    (error) => error?.code === 'INVENTORY_REJECTED',
  );

  assert.equal((await store.snapshot()).instances.length, 0);
  const [rejected] = await quarantines.list();
  assert.equal(rejected.packageDigest, archive.integrity);
  assert.equal(rejected.failure.code, 'INVALID_GRANT');
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
