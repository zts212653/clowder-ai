import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'clean-path.mjs');

function run(cwd, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('removes a relative target inside the current directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-path-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'artifact.js'), 'x');
    const result = run(root, ['dist']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'dist')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('succeeds when the target is already absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-path-'));
  try {
    const result = run(root, ['dist']);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses an intermediate link that redirects deletion outside the current directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'clean-path-'));
  const packageRoot = join(base, 'package');
  const outside = join(base, 'outside');
  const victim = join(outside, 'victim');
  try {
    mkdirSync(packageRoot);
    mkdirSync(outside);
    writeFileSync(victim, 'must survive');
    symlinkSync(outside, join(packageRoot, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = run(packageRoot, ['link/victim']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /redirected outside/);
    assert.equal(existsSync(victim), true, 'must not delete through an intermediate link');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refuses absolute and parent-relative targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-path-'));
  try {
    for (const target of [root, '../outside']) {
      const result = run(root, [target]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /refusing/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
