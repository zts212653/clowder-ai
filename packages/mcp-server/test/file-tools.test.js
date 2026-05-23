import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP file slice tools', () => {
  let originalEnv;
  let tempDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-file-slice-'));
    process.env.ALLOWED_WORKSPACE_DIRS = tempDir;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('handleReadFileSlice returns bounded numbered lines', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');
    const filePath = join(tempDir, 'source.md');
    writeFileSync(filePath, ['alpha', 'beta', 'gamma', 'delta'].join('\n'));

    const result = await handleReadFileSlice({ path: filePath, startLine: 2, endLine: 3 });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes(`File slice: ${filePath}:2-3`));
    assert.ok(text.includes('2: beta'));
    assert.ok(text.includes('3: gamma'));
    assert.ok(!text.includes('1: alpha'));
    assert.ok(!text.includes('4: delta'));
  });

  test('handleReadFileSlice reads repo-relative docs paths when cwd is allowed', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');
    const originalCwd = process.cwd();
    mkdirSync(join(tempDir, 'docs', 'features'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'features', 'F209.md'), ['alpha', 'beta', 'gamma'].join('\n'));

    try {
      process.chdir(tempDir);
      const result = await handleReadFileSlice({
        path: 'docs/features/F209.md',
        startLine: 2,
        endLine: 2,
      });

      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      assert.ok(text.includes('File slice:'));
      assert.ok(text.includes('2: beta'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('handleReadFileSlice rejects oversized ranges', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');
    const filePath = join(tempDir, 'source.md');
    writeFileSync(filePath, 'alpha\n');

    const result = await handleReadFileSlice({ path: filePath, startLine: 1, endLine: 401 });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /max is 400/);
  });

  test('handleReadFileSlice enforces allowed directories', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');

    const result = await handleReadFileSlice({ path: '/etc/hosts', startLine: 1, endLine: 2 });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Access denied/);
  });

  test('handleReadFileSlice resolves virtual collection paths through the collection manifest', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');
    const dataDir = join(tempDir, 'data');
    const root = join(tempDir, 'collection-root');
    const filePath = join(root, 'docs', 'source.md');
    mkdirSync(join(dataDir, 'library'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    process.env.CAT_CAFE_DATA_DIR = dataDir;
    writeFileSync(
      join(dataDir, 'library', 'collections.json'),
      JSON.stringify([
        {
          id: 'world:durable-root',
          kind: 'world',
          name: 'durable-root',
          displayName: 'Durable Root',
          root,
          sensitivity: 'internal',
          scannerLevel: 1,
          indexPolicy: { autoRebuild: false },
          reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
          createdAt: '2026-05-22T00:00:00.000Z',
          updatedAt: '2026-05-22T00:00:00.000Z',
        },
      ]),
    );
    writeFileSync(filePath, ['alpha', 'beta', 'gamma', 'delta'].join('\n'));

    const result = await handleReadFileSlice({
      path: 'cat-cafe://collection/world%3Adurable-root/docs/source.md',
      startLine: 2,
      endLine: 3,
    });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('File slice: cat-cafe://collection/world%3Adurable-root/docs/source.md:2-3'));
    assert.ok(text.includes('2: beta'));
    assert.ok(text.includes('3: gamma'));
  });
});
