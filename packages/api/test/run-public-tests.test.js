import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chunkFiles, resolveFiles } from '../scripts/run-public-tests.mjs';

const BASE_ARGS = ['--import', 'file:///setup.mjs', '--test', '--test-concurrency=1'];

test('chunkFiles keeps every file exactly once and below the argv budget', () => {
  const files = Array.from({ length: 500 }, (_, index) => `test/path with spaces/${index}.test.js`);
  const chunks = chunkFiles(files, BASE_ARGS);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), files);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0);
    const length = [...BASE_ARGS, ...chunk].reduce((total, arg) => total + arg.length + 1, 0);
    assert.ok(length <= 6000, `chunk argv length was ${length}`);
  }
});

test('resolveFiles fails closed when the resolver exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-resolver-'));
  try {
    const resolver = join(dir, 'fail.mjs');
    writeFileSync(resolver, 'process.exit(3);\n');
    assert.throws(() => resolveFiles(resolver), /exited 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveFiles fails closed when the resolver returns an empty set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-resolver-'));
  try {
    const resolver = join(dir, 'empty.mjs');
    writeFileSync(resolver, 'process.exit(0);\n');
    assert.throws(() => resolveFiles(resolver), /empty file set/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveFiles returns the resolver file list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-resolver-'));
  try {
    const resolver = join(dir, 'ok.mjs');
    writeFileSync(resolver, "console.log('test/a.test.js\\ntest/b.test.js');\n");
    assert.deepEqual(resolveFiles(resolver), ['test/a.test.js', 'test/b.test.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
