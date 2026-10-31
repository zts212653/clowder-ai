import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { generateBundledPluginArtifacts } from '../scripts/bundled-plugin-artifacts.mjs';
import { canonicalGzip } from '../scripts/canonical-gzip.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bundled-artifact-encoding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pluginRoot = pathToFileURL(`${directory}/`);
  const packagePath = join(directory, 'bundled-packages/fixture/1.0.0');
  await mkdir(join(packagePath, 'assets'), { recursive: true });
  await writeFile(
    join(packagePath, 'assets/icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
  );
  const definitions = [
    {
      catalogId: 'fixture',
      manifest: { pluginId: 'fixture.plugin', version: '1.0.0', icon: { src: 'assets/icon.svg' } },
    },
  ];
  await generateBundledPluginArtifacts(pluginRoot, definitions);
  return {
    archivePath: join(packagePath, 'package.tgz'),
    indexPath: join(directory, 'bundled-packages/index.json'),
    manifestPath: join(packagePath, 'manifest.json'),
    check: () => generateBundledPluginArtifacts(pluginRoot, definitions, { check: true }),
  };
}

const digest = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

async function replaceArchive(f, bytes, updateDigest = true) {
  const previous = await readFile(f.archivePath);
  await writeFile(f.archivePath, bytes);
  if (updateDigest) {
    const index = await readFile(f.indexPath, 'utf8');
    assert.ok(index.includes(digest(previous)));
    await writeFile(f.indexPath, index.replace(digest(previous), digest(bytes)));
  }
}

for (const encoding of ['OS header', 'DEFLATE stream']) {
  test(`a same-version archive rejects changed ${encoding} even with a refreshed SRI`, async (t) => {
    const f = await fixture(t);
    const original = await readFile(f.archivePath);
    const encoded = encoding === 'OS header' ? Buffer.from(original) : gzipSync(gunzipSync(original), { level: 0 });
    if (encoding === 'OS header') encoded[9] = original[9] === 3 ? 19 : 3;
    assert.notDeepEqual(encoded, original);
    assert.deepEqual(gunzipSync(encoded), gunzipSync(original));
    await replaceArchive(f, encoded);
    const before = await Promise.all([f.archivePath, f.indexPath, f.manifestPath].map((path) => readFile(path)));
    await assert.rejects(f.check(), /stale bundled artifact: .*package\.tgz/);
    const after = await Promise.all([f.archivePath, f.indexPath, f.manifestPath].map((path) => readFile(path)));
    assert.deepEqual(after, before, 'checking must not rewrite installed release identity');
  });
}

test('a changed canonical asset is rejected even when the archive SRI is refreshed', async (t) => {
  const f = await fixture(t);
  const tar = gunzipSync(await readFile(f.archivePath));
  tar[512] ^= 1;
  await replaceArchive(f, gzipSync(tar));
  await assert.rejects(f.check(), /stale bundled artifact: .*package\.tgz/);
});

test('extra decoded bytes are rejected even when the archive SRI is refreshed', async (t) => {
  const f = await fixture(t);
  const tar = gunzipSync(await readFile(f.archivePath));
  await replaceArchive(f, gzipSync(Buffer.concat([tar, Buffer.from('unowned tail')])));
  await assert.rejects(f.check(), /stale bundled artifact: .*package\.tgz/);
});

test('invalid gzip does not become a valid artifact by updating its SRI', async (t) => {
  const f = await fixture(t);
  await replaceArchive(f, Buffer.from('not a gzip archive'));
  await assert.rejects(f.check());
});

test('canonical gzip is the same RFC wire bytes on every builder', () => {
  assert.equal(
    canonicalGzip(Buffer.from('hello')).toString('hex'),
    '1f8b08000000000000ff010500faff68656c6c6f86a6103605000000',
  );
  for (const size of [0, 65534, 65535, 65536, 131070, 131071]) {
    const input = Buffer.alloc(size, 0x61);
    const output = canonicalGzip(input);
    assert.deepEqual(gunzipSync(output), input);
    const blocks = Math.max(1, Math.ceil(size / 65535));
    assert.equal(output.length, 18 + blocks * 5 + size);
    for (let index = 0, offset = 10; index < blocks; index++) {
      const length = Math.min(65535, size - index * 65535);
      assert.equal(output[offset], index === blocks - 1 ? 1 : 0);
      assert.equal(output.readUInt16LE(offset + 1), length);
      assert.equal(output.readUInt16LE(offset + 3), length ^ 0xffff);
      offset += length + 5;
    }
  }
});

test('canonical bytes still require their exact registered SRI', async (t) => {
  const f = await fixture(t);
  const index = JSON.parse(await readFile(f.indexPath, 'utf8'));
  index.fixture.packageDigest = digest(Buffer.from('wrong release'));
  await writeFile(f.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  await assert.rejects(f.check(), /stale bundled artifact: .*index\.json/);
});
