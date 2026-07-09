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

// F159 Phase G G1 AC-G5 P2 fix (@gpt555 review on PR #23):
// `clientFamily` must actually guard the resolved profile — an OAuth Anthropic
// builtin must NOT silently resolve under `clientFamily='openai'`.
test('resolveApiCredentials fail-closes when OAuth builtin family mismatches requested clientFamily', () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-cred-fam-')));
  const configDir = join(tmpDir, '.cat-cafe');
  mkdirSync(configDir, { recursive: true });
  // `claude` is the Anthropic OAuth builtin per BUILTIN_ACCOUNT_MAP.
  writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({ claude: { authType: 'oauth' } }));
  writeFileSync(join(configDir, 'credentials.json'), JSON.stringify({ claude: { apiKey: 'sk-ant-test' } }), {
    mode: 0o600,
  });
  try {
    // Sanity: same family resolves (anthropic adapter binding to claude).
    const ok = resolveApiCredentials(tmpDir, 'opus', { accountRef: 'claude' }, 'anthropic');
    assert.ok(ok && ok.apiKey === 'sk-ant-test', 'matching clientFamily must resolve');

    // Mismatch: anthropic builtin must not satisfy openai adapter.
    const mismatch = resolveApiCredentials(tmpDir, 'opus', { accountRef: 'claude' }, 'openai');
    assert.equal(mismatch, null, 'mismatched clientFamily must fail closed (anthropic builtin under openai adapter)');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// F159 Phase G G2 AC-G20/G21/G22 (KD-22): completes G1 P2 fix's half coverage.
// api_key accounts can now declare `clientFamily` in their schema. When set,
// `accountToRuntimeProfile` propagates it to `profile.client`, which the G1
// narrow guard already enforces — so api_key family mismatches now fail closed
// the same way OAuth builtin mismatches do. Without `clientFamily` set, legacy
// api_key accounts continue best-effort (backward compat preserved).
test('resolveApiCredentials fail-closes when api_key clientFamily mismatches requested clientFamily', () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-cred-apikey-fam-')));
  const configDir = join(tmpDir, '.cat-cafe');
  mkdirSync(configDir, { recursive: true });
  // Custom api_key account explicitly declared as OpenAI family.
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ 'my-openai-proxy': { authType: 'api_key', clientFamily: 'openai' } }),
  );
  writeFileSync(
    join(configDir, 'credentials.json'),
    JSON.stringify({ 'my-openai-proxy': { apiKey: 'sk-openai-proxy-test' } }),
    { mode: 0o600 },
  );
  try {
    // Sanity: matching family resolves.
    const ok = resolveApiCredentials(tmpDir, 'opus', { accountRef: 'my-openai-proxy' }, 'openai');
    assert.ok(ok && ok.apiKey === 'sk-openai-proxy-test', 'matching api_key clientFamily must resolve');

    // Mismatch: openai api_key account must not satisfy anthropic adapter.
    const mismatch = resolveApiCredentials(tmpDir, 'opus', { accountRef: 'my-openai-proxy' }, 'anthropic');
    assert.equal(
      mismatch,
      null,
      'mismatched api_key clientFamily must fail closed (openai api_key under anthropic adapter)',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// F159 Phase G G2 backward-compat (KD-22): existing api_key accounts without
// `clientFamily` continue to resolve best-effort. profile.client remains
// undefined, so the family guard falls through and the bound credential is
// returned regardless of requested clientFamily — runtime API call surfaces
// any protocol mismatch at first invocation rather than silently routing.
test('resolveApiCredentials resolves api_key account without clientFamily for any requested family (backward compat)', () => {
  const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'catagent-cred-apikey-legacy-')));
  const configDir = join(tmpDir, '.cat-cafe');
  mkdirSync(configDir, { recursive: true });
  // Legacy api_key account without explicit clientFamily — pre-F159 G2 state.
  writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({ 'legacy-account': { authType: 'api_key' } }));
  writeFileSync(
    join(configDir, 'credentials.json'),
    JSON.stringify({ 'legacy-account': { apiKey: 'sk-legacy-test' } }),
    { mode: 0o600 },
  );
  try {
    // Both adapter families resolve — guard falls through because
    // profile.client is undefined for legacy api_key.
    const asAnthropic = resolveApiCredentials(tmpDir, 'opus', { accountRef: 'legacy-account' }, 'anthropic');
    assert.ok(
      asAnthropic && asAnthropic.apiKey === 'sk-legacy-test',
      'legacy api_key resolves under anthropic adapter',
    );

    const asOpenai = resolveApiCredentials(tmpDir, 'opus', { accountRef: 'legacy-account' }, 'openai');
    assert.ok(asOpenai && asOpenai.apiKey === 'sk-legacy-test', 'legacy api_key resolves under openai adapter');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
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
