import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const withTestHome = resolve(__dirname, '../scripts/with-test-home.sh');

test('with-test-home forces NODE_ENV=test even when outer shell is production', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.NODE_ENV'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'test');
});

test('with-test-home strips runtime default cat override from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.DEFAULT_CAT_ID ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      DEFAULT_CAT_ID: 'codex',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips runtime API host binding from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.API_SERVER_HOST ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      API_SERVER_HOST: '0.0.0.0',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips runtime workspace allowlist from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.ALLOWED_WORKSPACE_DIRS ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      ALLOWED_WORKSPACE_DIRS: '/Users/example/projects',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips configured owner from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.DEFAULT_OWNER_USER_ID ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      DEFAULT_OWNER_USER_ID: 'configured-owner',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});
