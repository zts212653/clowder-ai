import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

import { bundledBuildFixture as fixture } from './helpers/bundled-plugin-build-fixture.js';

const frozenSha256 = 'a39d8168901fd47091a15266571f12dcc82693f5d0cd73ae8d87043e1931ef99';

function archiveManifest(archive, prebuilt = false) {
  const tar = gunzipSync(archive);
  const target = prebuilt ? 'package/plugin.yaml' : 'package/manifest.json';
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0; ) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .split('\0')[0];
    const length = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
    assert.ok(Number.isSafeInteger(length) && length >= 0 && offset + 512 + length <= tar.length);
    if (name === target) {
      const text = tar.subarray(offset + 512, offset + 512 + length).toString();
      return prebuilt ? parse(text) : JSON.parse(text);
    }
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  assert.fail(`archive must contain ${target}`);
}

for (const fromSource of [false, true]) {
  test(`native build preserves the frozen Dot release bytes (source=${fromSource})`, async (t) => {
    const f = await fixture(t, undefined, fromSource, { prebuilt: true });
    const original = await readFile(f.sourceArchivePath);
    const inputManifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
    assert.equal(createHash('sha256').update(original).digest('hex'), frozenSha256);
    const built = f.build();
    assert.equal(built.status, 0, built.stderr);
    const index = JSON.parse(await readFile(join(f.pluginRoot, 'bundled-packages/index.json'), 'utf8'));
    const record = index['chatgpt-dot'];
    assert.equal(record.archiveUrl, `builtin://chatgpt-dot/${f.version}`);
    assert.equal(record.packageDigest, `sha512-${createHash('sha512').update(original).digest('base64')}`);
    assert.deepEqual(await readFile(join(f.pluginRoot, 'bundled-packages', record.archivePath)), original);
    const manifest = archiveManifest(original, true);
    assert.deepEqual(inputManifest, manifest);
    const validated = validateManifest(manifest);
    assert.equal(validated.valid, true);
    // The Host projection deliberately drops retired manifest fields; the frozen
    // archive retains its original bytes and is never rebuilt from that projection.
    assert.deepEqual(
      JSON.parse(await readFile(join(f.pluginRoot, `bundled-packages/chatgpt-dot/${f.version}/manifest.json`), 'utf8')),
      validated.manifest,
    );
    assert.equal(f.build('--check').status, 0);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] ^= 1;
    await writeFile(f.sourceArchivePath, corrupted);
    for (const args of [[], ['--check']]) {
      const rejected = f.build(...args);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /prebuilt archive SHA256 drift/);
      assert.deepEqual(await readFile(join(f.pluginRoot, 'bundled-packages', record.archivePath)), original);
    }
  });
}

test('frozen build runs the production archive preflight on the exact release bytes', async (t) => {
  const f = await fixture(t, undefined, false, { prebuilt: true });
  // Preserve the unsafe-member regression without shipping an obsolete 18 MB release.
  const header = Buffer.alloc(512);
  header.write('package/../escape');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write('00000000001\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  await f.replacePrebuiltArchive(gzipSync(Buffer.concat([header, Buffer.alloc(512), Buffer.alloc(1024)])));
  const built = f.build();
  assert.notEqual(built.status, 0, 'a hash-matched release must still pass production archive admission');
  assert.match(built.stderr, /unsafe member path/);
});

for (const ancestor of ['package.tgz', 'version', 'chatgpt-dot', 'bundled-packages']) {
  test(`frozen build refuses a source link/junction: ${ancestor}`, async (t) => {
    const f = await fixture(t, undefined, false, { prebuilt: true });
    const linked =
      ancestor === 'package.tgz'
        ? f.sourceArchivePath
        : ancestor === 'version'
          ? dirname(f.sourceArchivePath)
          : ancestor === 'chatgpt-dot'
            ? dirname(dirname(f.sourceArchivePath))
            : join(f.root, 'src/domains/plugin/bundled-packages');
    // The target stays inside the fixture root: containment alone must not admit links.
    const relocated = join(f.root, 'linked-input');
    await cp(linked, relocated, { recursive: true });
    await rm(linked, { recursive: true });
    await symlink(
      relocated,
      linked,
      ancestor === 'package.tgz' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir',
    );
    const built = f.build();
    assert.notEqual(built.status, 0);
    assert.match(built.stderr, /prebuilt archive.*(?:inside|links\/junctions)/);
  });
}

for (const description of ['Fixture team: home', 'Fixture team: public']) {
  test(`native build produces the selected producer bytes from JSON and SVG inputs: ${description}`, async (t) => {
    const f = await fixture(t, description, description.endsWith('home'));
    const built = f.build();
    assert.equal(built.status, 0, built.stderr);
    const index = JSON.parse(await readFile(join(f.pluginRoot, 'bundled-packages/index.json'), 'utf8'));
    const record = index['chatgpt-dot'];
    assert.equal(record.pluginId, 'official.chatgpt-dot');
    assert.equal(record.archiveUrl, `builtin://chatgpt-dot/${f.version}`);
    const archive = await readFile(join(f.pluginRoot, 'bundled-packages', record.archivePath));
    assert.equal(record.packageDigest, `sha512-${createHash('sha512').update(archive).digest('base64')}`);
    // Parse the actual canonical TAR entry instead of matching arbitrary compressed text.
    const manifest = archiveManifest(archive);
    assert.equal(manifest.description, description);
    assert.deepEqual(
      JSON.parse(await readFile(join(f.pluginRoot, `bundled-packages/chatgpt-dot/${f.version}/manifest.json`), 'utf8')),
      manifest,
    );
    assert.deepEqual(
      await readdir(dirname(f.assets)),
      ['assets', 'dist', 'manifest.json'],
      'build must not write into the source tree',
    );
    const checked = f.build('--check');
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(await readFile(join(f.pluginRoot, 'bundled-packages', record.archivePath)), archive);
    await writeFile(join(f.pluginRoot, 'bundled-packages', record.archivePath), 'corrupt archive');
    assert.notEqual(f.build('--check').status, 0, 'checking must reject corruption rather than rebuild over it');
  });
}

test('native build refuses a symlink source icon', async (t) => {
  const f = await fixture(t, 'Fixture team');
  const icon = join(f.assets, 'chatgpt-cloud.svg');
  const original = join(f.root, 'external-icon.svg');
  await cp(icon, original);
  await rm(icon);
  try {
    await symlink(original, icon, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'ENOTSUP'].includes(error.code)) {
      t.skip('this filesystem cannot create a file symlink');
      return;
    }
    throw error;
  }
  const built = f.build();
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /bundled source.*(?:regular file|link|inside)/);
});

for (const ancestor of ['bundled-packages', 'bundled-packages/chatgpt-dot', 'version', 'assets']) {
  test(`native build refuses a source ancestor directory link/junction: ${ancestor}`, async (t) => {
    const f = await fixture(t, 'Fixture team');
    const linked =
      ancestor === 'assets'
        ? f.assets
        : ancestor === 'version'
          ? dirname(f.assets)
          : join(f.root, 'src/domains/plugin', ancestor);
    const external = join(f.root, 'external-input');
    await cp(linked, external, { recursive: true });
    await rm(linked, { recursive: true });
    await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const built = f.build();
    assert.notEqual(built.status, 0, 'a regular leaf must not admit bytes through an ancestor link');
    assert.match(built.stderr, /bundled source.*(?:inside|link)/);
  });
}

test('native build refuses an in-root directory link as well as an escaping link', async (t) => {
  const f = await fixture(t, 'Fixture team');
  const relocated = join(dirname(f.assets), 'real-assets');
  await cp(f.assets, relocated, { recursive: true });
  await rm(f.assets, { recursive: true });
  await symlink(relocated, f.assets, process.platform === 'win32' ? 'junction' : 'dir');
  const built = f.build();
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /bundled source.*link/);
});
