import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalGzip } from './canonical-gzip.mjs';

/** A deterministic USTAR containing only the producer's regular files. No filesystem metadata enters the SRI. */
export function tarArchive(files) {
  const blocks = [];
  for (const { name, bytes } of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    assert.ok(Buffer.byteLength(name) < 100 && !name.includes('..') && name.startsWith('package/'));
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    const octal = (offset, width, value) =>
      header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'ascii');
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, bytes.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

/** Build outputs from canonical manifests and regular SVG inputs; callers validate the manifest schema. */
export async function generateBundledPluginArtifacts(
  pluginRoot,
  definitions,
  { check = false, sourceRoot = pluginRoot } = {},
) {
  const outputRoot = fileURLToPath(new URL('bundled-packages', pluginRoot));
  const output = new Map();
  function recordFile(url, bytes) {
    const path = fileURLToPath(url);
    const name = relative(outputRoot, path);
    assert.ok(name && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`));
    assert.ok(!output.has(path), `duplicate bundled artifact: ${path}`);
    output.set(path, Buffer.from(bytes));
  }

  const records = [];
  for (const { catalogId, manifest } of definitions) {
    assert.ok(/^[a-z][a-z0-9-]*$/.test(catalogId), 'invalid bundled catalog id');
    assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version));
    assert.ok(/^assets\/[a-z-]+\.svg$/.test(manifest.icon.src));
    const relativeRoot = `bundled-packages/${catalogId}/${manifest.version}/`;
    const iconPath = new URL(`${relativeRoot}${manifest.icon.src}`, sourceRoot);
    const rootPath = await realpath(sourceRoot);
    const sourcePath = fileURLToPath(iconPath);
    const actualPath = await realpath(iconPath);
    const inside = relative(rootPath, actualPath);
    assert.ok(
      inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`),
      'bundled source icon must remain inside the source root',
    );
    // Root aliases (e.g. macOS /tmp) are allowed. Every component below the
    // canonical root must be unlinked, including directory symlinks/junctions.
    const components = relative(fileURLToPath(sourceRoot), sourcePath).split(sep);
    let current = rootPath;
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      const stat = await lstat(current);
      assert.ok(!stat.isSymbolicLink(), 'bundled source must not contain links/junctions');
      assert.ok(
        index === components.length - 1 ? stat.isFile() : stat.isDirectory(),
        'bundled source icon must be a regular file with directory ancestors',
      );
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const iconBytes = await readFile(iconPath);
    const tarBytes = tarArchive([
      { name: 'package/manifest.json', bytes: manifestBytes },
      { name: `package/${manifest.icon.src}`, bytes: iconBytes },
    ]);
    const archivePath = `${catalogId}/${manifest.version}/package.tgz`;
    const archiveUrl = new URL(`bundled-packages/${archivePath}`, pluginRoot);
    recordFile(new URL(`${relativeRoot}manifest.json`, pluginRoot), manifestBytes);
    recordFile(new URL(`${relativeRoot}${manifest.icon.src}`, pluginRoot), iconBytes);
    // Release identity is exact compressed bytes, not just decoded TAR content.
    // The encoder uses fixed metadata/stored DEFLATE and never invokes zlib.
    const bytes = canonicalGzip(tarBytes);
    recordFile(archiveUrl, bytes);
    records.push({
      catalogId,
      pluginId: manifest.pluginId,
      version: manifest.version,
      archiveUrl: `builtin://${catalogId}/${manifest.version}`,
      packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      archivePath,
    });
  }
  recordFile(
    new URL('bundled-packages/index.json', pluginRoot),
    `${JSON.stringify(Object.fromEntries(records.map((record) => [record.catalogId, record])), null, 2)}\n`,
  );
  // Read and validate every input before publishing anything. This namespace
  // belongs entirely to this producer; adjacent dist files are never removed.
  if (!check) {
    // rm unlinks an output symlink/junction rather than following its target.
    await rm(outputRoot, { recursive: true, force: true });
    for (const [path, bytes] of output) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    return;
  }
  const expectedEntries = new Set();
  for (const path of output.keys()) {
    for (let name = relative(outputRoot, path); name !== '.'; name = dirname(name)) expectedEntries.add(name);
  }
  const actualEntries = [];
  async function inspect(directory) {
    const stat = await lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `stale bundled artifact set: ${directory}`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.ok(entry.isFile() || entry.isDirectory(), `stale bundled artifact set: ${path}`);
      actualEntries.push(relative(outputRoot, path));
      if (entry.isDirectory()) await inspect(path);
    }
  }
  await inspect(outputRoot);
  assert.deepEqual(actualEntries.sort(), [...expectedEntries].sort(), 'stale bundled artifact set');
  for (const [path, bytes] of output) {
    assert.deepEqual(await readFile(path), bytes, `stale bundled artifact: ${path}`);
  }
}
