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
  {
    check = false,
    sourceRoot = pluginRoot,
    formatManifest = (text) => text,
    validatePrebuiltArchive = async () => {},
  } = {},
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
  for (const { catalogId, manifest, agentProvider, files = [], prebuilt } of definitions) {
    assert.ok(/^[a-z][a-z0-9-]*$/.test(catalogId), 'invalid bundled catalog id');
    assert.ok(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version));
    const relativeRoot = `bundled-packages/${catalogId}/${manifest.version}/`;
    const manifestBytes = Buffer.from(formatManifest(`${JSON.stringify(manifest, null, 2)}\n`));
    if (prebuilt) {
      const archivePath = `${catalogId}/${manifest.version}/package.tgz`;
      const sourceArchiveUrl = new URL(`bundled-packages/${archivePath}`, sourceRoot);
      const rootPath = await realpath(sourceRoot);
      const sourcePath = fileURLToPath(sourceArchiveUrl);
      const actualPath = await realpath(sourceArchiveUrl);
      const inside = relative(rootPath, actualPath);
      assert.ok(
        inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`),
        'prebuilt archive must remain inside the source root',
      );
      const components = relative(fileURLToPath(sourceRoot), sourcePath).split(sep);
      let current = rootPath;
      for (const [index, component] of components.entries()) {
        current = join(current, component);
        const stat = await lstat(current);
        assert.ok(!stat.isSymbolicLink(), 'prebuilt archive must not contain links/junctions');
        assert.ok(
          index === components.length - 1 ? stat.isFile() : stat.isDirectory(),
          'prebuilt archive must be a regular file with directory ancestors',
        );
      }
      const bytes = await readFile(sourceArchiveUrl);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), prebuilt.sha256, 'prebuilt archive SHA256 drift');
      await validatePrebuiltArchive(sourcePath);
      recordFile(new URL(`${relativeRoot}manifest.json`, pluginRoot), manifestBytes);
      recordFile(new URL(`${relativeRoot}package.tgz`, pluginRoot), bytes);
      records.push({
        catalogId,
        pluginId: manifest.pluginId,
        version: manifest.version,
        archiveUrl: `builtin://${catalogId}/${manifest.version}`,
        packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        archivePath,
      });
      continue;
    }
    const sourceFiles = [...new Set([...(manifest.icon?.src ? [manifest.icon.src] : []), ...files])];
    if (manifest.runtime?.entrypoint)
      assert.ok(sourceFiles.includes(manifest.runtime.entrypoint), 'bundle must include its runtime entrypoint');
    const packageFiles = [];
    for (const name of sourceFiles) {
      assert.ok(
        typeof name === 'string' &&
          /^[A-Za-z0-9_./-]+$/.test(name) &&
          !name.startsWith('/') &&
          !name.split('/').some((part) => !part || part === '.' || part === '..'),
        'invalid bundled source path',
      );
      assert.ok(
        !['manifest.json', 'plugin.yaml', 'agent-provider.json', 'package.tgz'].includes(name),
        'reserved bundled source path',
      );
      const sourceUrl = new URL(`${relativeRoot}${name}`, sourceRoot);
      const rootPath = await realpath(sourceRoot);
      const sourcePath = fileURLToPath(sourceUrl);
      const actualPath = await realpath(sourceUrl);
      const inside = relative(rootPath, actualPath);
      assert.ok(
        inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`),
        'bundled source must remain inside the source root',
      );
      const components = relative(fileURLToPath(sourceRoot), sourcePath).split(sep);
      let current = rootPath;
      for (const [index, component] of components.entries()) {
        current = join(current, component);
        const stat = await lstat(current);
        assert.ok(!stat.isSymbolicLink(), 'bundled source must not contain links/junctions');
        assert.ok(
          index === components.length - 1 ? stat.isFile() : stat.isDirectory(),
          'bundled source must be a regular file with directory ancestors',
        );
      }
      packageFiles.push({ name: `package/${name}`, bytes: await readFile(sourceUrl) });
    }
    const providerBytes =
      agentProvider === undefined ? undefined : Buffer.from(`${JSON.stringify(agentProvider, null, 2)}\n`);
    const tarBytes = tarArchive([
      { name: 'package/manifest.json', bytes: manifestBytes },
      ...packageFiles,
      ...(providerBytes ? [{ name: 'package/agent-provider.json', bytes: providerBytes }] : []),
    ]);
    const archivePath = `${catalogId}/${manifest.version}/package.tgz`;
    const archiveUrl = new URL(`bundled-packages/${archivePath}`, pluginRoot);
    recordFile(new URL(`${relativeRoot}manifest.json`, pluginRoot), manifestBytes);
    for (const file of packageFiles)
      recordFile(new URL(`${relativeRoot}${file.name.slice(8)}`, pluginRoot), file.bytes);
    if (providerBytes) recordFile(new URL(`${relativeRoot}agent-provider.json`, pluginRoot), providerBytes);
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
