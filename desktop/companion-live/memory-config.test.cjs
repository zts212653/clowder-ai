const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, mkdir, writeFile, symlink, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');
const { buildMemoryConfig } = require('./memory-config.cjs');

test('document permission does not expose global memory navigation', () => {
  const options = {
    synthetic: false,
    allowHomeReads: false,
    root: '/fixture',
    storage: '/fixture/session',
    memoryEntry: '/fixture/memory.js',
    node: 'node',
  };
  assert.equal(buildMemoryConfig(options).enabled, false);
  const granted = buildMemoryConfig({ ...options, allowHomeReads: true });
  assert.equal(granted.enabled, true);
  assert.deepEqual(granted.enabled_tools, ['cat_cafe_read_file_slice']);
});

test('canonical file reader permits feature and F317 discussion files, denies other docs and symlink escapes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'f317-memory-scope-'));
  const previous = { ...process.env };
  const { handleReadFileSlice } = await import('../../packages/mcp-server/dist/tools/file-tools.js');
  try {
    const paths = [
      'docs/features/F317.md',
      'docs/discussions/2026-09-15-f317-coactive-companion/README.md',
      'docs/discussions/other/README.md',
      'docs/private.md',
    ];
    for (const path of paths) {
      await mkdir(resolve(root, path, '..'), { recursive: true });
      await writeFile(resolve(root, path), 'synthetic fixture only');
    }
    await symlink(resolve(root, 'docs/private.md'), resolve(root, 'docs/features/escape.md'));
    const config = buildMemoryConfig({ root, storage: resolve(root, 'session'), allowHomeReads: true });
    Object.assign(process.env, config.env);
    for (const path of paths.slice(0, 2)) {
      assert.notEqual((await handleReadFileSlice({ path: resolve(root, path), startLine: 1 })).isError, true);
    }
    for (const path of [...paths.slice(2), 'docs/features/escape.md', 'docs/features/../private.md']) {
      const result = await handleReadFileSlice({ path: resolve(root, path), startLine: 1 });
      assert.equal(result.isError, true, `must deny ${path}`);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});
