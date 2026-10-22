import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'cleanup-stale-dev-processes.mjs');

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 });
}

function aliasFixture() {
  const root = mkdtempSync(join(tmpdir(), 'stale-process-alias-'));
  const alias = join(root, 'alias with spaces');
  symlinkSync(dirname(script), alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, aliasScript: join(alias, 'cleanup-stale-dev-processes.mjs') };
}

test('importing the process doctor stays inert', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(script).href)});`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('a missing entry path stays inert', () => {
  const missing = pathToFileURL(join(tmpdir(), 'definitely-missing-stale-process-entry.mjs')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `process.argv[1] = ${JSON.stringify(new URL(missing).pathname)}; await import(${JSON.stringify(pathToFileURL(script).href)});`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('Windows alias/junction path still reaches the unsupported branch', { skip: process.platform !== 'win32' }, () => {
  const fixture = aliasFixture();
  try {
    const result = spawnSync(process.execPath, [fixture.aliasScript], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Windows process enumeration\/cleanup is not supported yet/);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('POSIX alias path enters the real entrypoint', { skip: process.platform === 'win32' }, () => {
  const fixture = aliasFixture();
  const bin = join(fixture.root, 'bin');
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [fixture.aliasScript], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no cleanup-safe stale/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test(
  'Windows direct execution fails closed instead of silently succeeding',
  { skip: process.platform !== 'win32' },
  () => {
    for (const args of [[], ['--run']]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Windows process enumeration\/cleanup is not supported yet/);
      assert.doesNotMatch(result.stderr, /no cleanup-safe stale/);
      assert.equal(result.stdout, '');
    }
  },
);
