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

  test('F324: a 250k single line is bounded and exactly recoverable by charOffset', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');
    const filePath = join(tempDir, 'one-long-line.txt');
    const original = 'x'.repeat(250_000);
    writeFileSync(filePath, original);

    let charOffset = 0;
    let recovered = '';
    for (let page = 0; page < 20; page += 1) {
      const result = await handleReadFileSlice({ path: filePath, startLine: 1, endLine: 1, charOffset });
      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      assert.ok(text.length <= 24_000, `page ${page} used ${text.length} chars`);
      recovered += text.match(/^1: (.*)$/m)?.[1] ?? '';
      const next = text.match(/Next slice: .*charOffset=(\d+)/);
      if (!next) break;
      charOffset = Number(next[1]);
    }
    assert.equal(recovered, original);
  });

  test('partial Markdown metadata is not presented as a complete reading of the document rules', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');
    const filePath = join(tempDir, 'guidance.md');
    writeFileSync(
      filePath,
      ['---', 'theme: quiet', 'spacing: 8', '---', '# Rules', 'Use the current rule.'].join('\n'),
    );

    const partial = await handleReadFileSlice({ path: filePath, startLine: 1, endLine: 2 });
    assert.match(partial.content[0].text, /document body has not been read/);
    assert.match(partial.content[0].text, /Document body: .*startLine=5, endLine=124/);
    assert.match(partial.content[0].text, /Next slice: .*startLine=3, endLine=4, charOffset=0/);
    assert.ok(!partial.content[0].text.includes('Use the current rule.'));

    const body = await handleReadFileSlice({ path: filePath, startLine: 5, endLine: 6 });
    assert.match(body.content[0].text, /Use the current rule/);
    assert.doesNotMatch(body.content[0].text, /document body has not been read|Next slice:/);

    writeFileSync(filePath, ['---', ...Array(600).fill('theme: quiet'), '---', '# Far body'].join('\n'));
    const distantBody = await handleReadFileSlice({ path: filePath, startLine: 1, endLine: 2 });
    assert.doesNotMatch(distantBody.content[0].text, /Document body:|Far body/);
    assert.match(distantBody.content[0].text, /Next slice:/);
  });

  test('Live local reads require an explicit directory; ordinary callers retain the default data root', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');
    const docs = join(tempDir, 'approved-docs');
    const data = join(tempDir, 'local-data');
    mkdirSync(docs);
    mkdirSync(data);
    const filePath = join(data, 'synthetic-private.txt');
    writeFileSync(filePath, 'SYNTHETIC_LOCAL_DATA');
    process.env.ALLOWED_WORKSPACE_DIRS = docs;
    process.env.CAT_CAFE_DATA_DIR = data;
    delete process.env.CAT_CAFE_DESKTOP_MODE;
    assert.equal((await handleReadFileSlice({ path: filePath, startLine: 1 })).isError, undefined);
    process.env.CAT_CAFE_DESKTOP_MODE = 'live-companion';
    const denied = await handleReadFileSlice({ path: filePath, startLine: 1 });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /Access denied/);
    assert.ok(!denied.content[0].text.includes('SYNTHETIC_LOCAL_DATA'));
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

  test('handleReadFileSlice resolves repo-relative docs paths when cwd is sibling subdir but ALLOWED_WORKSPACE_DIRS points to workspace root', async () => {
    const { handleReadFileSlice } = await import('../dist/tools/file-tools.js');
    const originalCwd = process.cwd();
    mkdirSync(join(tempDir, 'packages', 'api'), { recursive: true });
    mkdirSync(join(tempDir, 'docs', 'features'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'features', 'F209.md'), ['alpha', 'beta', 'gamma'].join('\n'));

    try {
      process.chdir(join(tempDir, 'packages', 'api'));
      const result = await handleReadFileSlice({
        path: 'docs/features/F209.md',
        startLine: 2,
        endLine: 2,
      });

      assert.equal(result.isError, undefined, `expected success but got error: ${result.content?.[0]?.text ?? ''}`);
      const text = result.content[0].text;
      assert.ok(text.includes('2: beta'), `expected "2: beta" in: ${text}`);
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
