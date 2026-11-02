import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { bundledBuildFixture as fixture } from './helpers/bundled-plugin-build-fixture.js';

for (const description of ['Fixture team: home', 'Fixture team: public']) {
  test(`native build produces the selected producer bytes without checked-in packages: ${description}`, async (t) => {
    const f = await fixture(t, description, description.endsWith('home'));
    const built = f.build();
    assert.equal(built.status, 0, built.stderr);
    const index = JSON.parse(await readFile(join(f.pluginRoot, 'bundled-packages/index.json'), 'utf8'));
    const record = index['chatgpt-dot'];
    assert.equal(record.pluginId, 'official.chatgpt-dot');
    assert.equal(record.archiveUrl, 'builtin://chatgpt-dot/0.1.2');
    const archive = await readFile(join(f.pluginRoot, 'bundled-packages', record.archivePath));
    assert.equal(record.packageDigest, `sha512-${createHash('sha512').update(archive).digest('base64')}`);
    const tar = gunzipSync(archive);
    // Parse the actual canonical TAR entry instead of matching arbitrary compressed text.
    const manifestOffset = tar.indexOf(Buffer.from('package/manifest.json\0'));
    assert.ok(manifestOffset >= 0 && manifestOffset % 512 === 0);
    const length = Number.parseInt(tar.subarray(manifestOffset + 124, manifestOffset + 136).toString(), 8);
    const manifest = JSON.parse(tar.subarray(manifestOffset + 512, manifestOffset + 512 + length).toString());
    assert.equal(manifest.description, description);
    assert.deepEqual(
      JSON.parse(await readFile(join(f.pluginRoot, 'bundled-packages/chatgpt-dot/0.1.2/manifest.json'), 'utf8')),
      manifest,
    );
    assert.deepEqual(await readdir(dirname(f.assets)), ['assets'], 'build must not write into the source tree');
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
  const original = fileURLToPath(
    new URL('../src/domains/plugin/bundled-packages/chatgpt-dot/0.1.2/assets/chatgpt-cloud.svg', import.meta.url),
  );
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

for (const ancestor of [
  'bundled-packages',
  'bundled-packages/chatgpt-dot',
  'bundled-packages/chatgpt-dot/0.1.2',
  'bundled-packages/chatgpt-dot/0.1.2/assets',
]) {
  test(`native build refuses a source ancestor directory link/junction: ${ancestor}`, async (t) => {
    const f = await fixture(t, 'Fixture team');
    const linked = join(f.root, 'src/domains/plugin', ancestor);
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
