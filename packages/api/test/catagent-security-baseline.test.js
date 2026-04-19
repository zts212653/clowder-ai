/**
 * CatAgent Security Baseline Tests — F159 Phase B
 *
 * Tests for the two security hard gates:
 * 1. Account-binding fail-closed credential resolution
 * 2. Symlink-safe sandbox (delegates to resolveWorkspacePath)
 *
 * Tool registry tests (read_file / list_files / search_content) ship in Phase D.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { resolveApiCredentials } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-credentials.js'
);

// -- Credentials (account-binding fail-closed) --

test('resolveApiCredentials returns null when catConfig is null', () => {
  const result = resolveApiCredentials('/tmp', 'opus', null);
  assert.equal(result, null, 'should return null for null catConfig');
});

test('resolveApiCredentials returns null when catConfig has no accountRef', () => {
  const result = resolveApiCredentials('/tmp', 'opus', { name: 'test' });
  assert.equal(result, null, 'should return null when no accountRef');
});

test('resolveApiCredentials returns null when bound account does not resolve', () => {
  const result = resolveApiCredentials('/tmp', 'opus', { accountRef: 'nonexistent-account-xyz' });
  assert.equal(result, null, 'should return null for unresolvable bound account');
});

test('resolveApiCredentials ignores env var — only bound account is authoritative', () => {
  process.env.CATAGENT_ANTHROPIC_API_KEY = 'sk-ant-should-be-ignored';
  try {
    const result = resolveApiCredentials('/tmp', 'opus', null);
    assert.equal(result, null, 'should return null — env override must not bypass account binding');
  } finally {
    delete process.env.CATAGENT_ANTHROPIC_API_KEY;
  }
});

test('resolveApiCredentials does not scan credentials.json even when key exists nearby', () => {
  // Seed a real credential file so a wildcard scanner would find it
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-cred-')));
  const configDir = join(tmpDir, '.cat-cafe');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'credentials.json'),
    JSON.stringify({ 'stray-anthropic-key': { apiKey: 'sk-ant-scannable-key' } }),
    { mode: 0o600 },
  );
  try {
    // Empty accountRef with a scannable key on disk — must still fail closed
    const result = resolveApiCredentials(tmpDir, 'opus', { accountRef: '' });
    assert.equal(result, null, 'should not fallback to credential scanning even with key on disk');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -- Sandbox (delegates to shared resolveWorkspacePath) --
// Error patterns match upstream WorkspaceSecurityError directly (no translation layer).

const { resolveSecurePath } = await import('../dist/domains/cats/services/agents/providers/catagent/catagent-tools.js');

test('resolveSecurePath allows paths within working directory', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    writeFileSync(join(tmpDir, 'test.txt'), 'hello');
    const result = await resolveSecurePath(tmpDir, 'test.txt');
    assert.ok(result.endsWith('test.txt'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks ../etc/passwd traversal', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    await assert.rejects(() => resolveSecurePath(tmpDir, '../../../etc/passwd'), /Path outside workspace root/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks sibling prefix traversal', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  const siblingDir = `${tmpDir}2`;
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(join(siblingDir, 'secret.txt'), 'leaked');
  try {
    await assert.rejects(
      () => resolveSecurePath(tmpDir, `../${tmpDir.split('/').pop()}2/secret.txt`),
      /Path outside workspace root/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(siblingDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks symlink escape', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-outside-')));
  writeFileSync(join(outsideDir, 'secret.txt'), 'leaked');
  try {
    symlinkSync(outsideDir, join(tmpDir, 'escape-link'));
    await assert.rejects(() => resolveSecurePath(tmpDir, 'escape-link/secret.txt'), /Symlink escapes workspace root/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks symlink to file outside workspace', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-outside-')));
  const secretFile = join(outsideDir, 'secret.txt');
  writeFileSync(secretFile, 'leaked');
  try {
    symlinkSync(secretFile, join(tmpDir, 'escape-file'));
    await assert.rejects(() => resolveSecurePath(tmpDir, 'escape-file'), /Symlink escapes workspace root/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath allows ENOENT (file does not exist yet)', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    const result = await resolveSecurePath(tmpDir, 'nonexistent.txt');
    assert.ok(result.endsWith('nonexistent.txt'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -- Denylist (shared with workspace-security.ts via delegation) --

test('resolveSecurePath blocks .env files', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    writeFileSync(join(tmpDir, '.env'), 'SECRET=leaked');
    await assert.rejects(() => resolveSecurePath(tmpDir, '.env'), /Access denied/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks .env.local variant', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    writeFileSync(join(tmpDir, '.env.local'), 'SECRET=leaked');
    await assert.rejects(() => resolveSecurePath(tmpDir, '.env.local'), /Access denied/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks .pem files', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    writeFileSync(join(tmpDir, 'server.pem'), 'CERT');
    await assert.rejects(() => resolveSecurePath(tmpDir, 'server.pem'), /Access denied/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks .key files', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    writeFileSync(join(tmpDir, 'private.key'), 'KEY');
    await assert.rejects(() => resolveSecurePath(tmpDir, 'private.key'), /Access denied/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks .git directory', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    mkdirSync(join(tmpDir, '.git'));
    writeFileSync(join(tmpDir, '.git', 'config'), 'leaked');
    await assert.rejects(() => resolveSecurePath(tmpDir, '.git/config'), /Access denied/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSecurePath blocks secrets directory', async () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-sec-')));
  try {
    mkdirSync(join(tmpDir, 'secrets'));
    writeFileSync(join(tmpDir, 'secrets', 'api-key.txt'), 'leaked');
    await assert.rejects(() => resolveSecurePath(tmpDir, 'secrets/api-key.txt'), /Access denied/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
