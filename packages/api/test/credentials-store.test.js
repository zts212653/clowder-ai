import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('credentials store', () => {
  let globalRoot;
  let previousGlobalRoot;

  beforeEach(async () => {
    globalRoot = await mkdtemp(join(tmpdir(), 'cred-store-'));
    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
  });

  afterEach(async () => {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    await rm(globalRoot, { recursive: true, force: true });
  });

  async function loadModule() {
    // Force fresh import each test (env may differ)
    const mod = await import(`../dist/config/credentials.js?t=${Date.now()}-${Math.random()}`);
    return mod;
  }

  it('readCredentials returns empty object when file does not exist', async () => {
    const { readCredentials } = await loadModule();
    const creds = readCredentials();
    assert.deepEqual(creds, {});
  });

  it('writeCredential creates file with 0o600 permissions', async () => {
    const { writeCredential, resolveCredentialsPath } = await loadModule();
    writeCredential('my-acct', { apiKey: 'sk-test-123' });

    const credPath = resolveCredentialsPath();
    const fileStat = await stat(credPath);
    // 0o600 = owner read+write only
    const mode = fileStat.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0o600 permissions, got 0o${mode.toString(8)}`);
  });

  it('writeCredential + readCredentials roundtrip', async () => {
    const { writeCredential, readCredentials } = await loadModule();
    writeCredential('claude', { apiKey: 'sk-ant-xxx' });
    writeCredential('my-glm', { apiKey: 'glm-key-123' });

    const creds = readCredentials();
    assert.equal(creds.claude?.apiKey, 'sk-ant-xxx');
    assert.equal(creds['my-glm']?.apiKey, 'glm-key-123');
  });

  it('writeCredential supports oauth token fields (HC-1)', async () => {
    const { writeCredential, readCredentials } = await loadModule();
    const oauthEntry = {
      accessToken: 'at-xyz',
      refreshToken: 'rt-abc',
      expiresAt: 1700000000000,
    };
    writeCredential('my-oauth', oauthEntry);

    const creds = readCredentials();
    assert.equal(creds['my-oauth']?.accessToken, 'at-xyz');
    assert.equal(creds['my-oauth']?.refreshToken, 'rt-abc');
    assert.equal(creds['my-oauth']?.expiresAt, 1700000000000);
  });

  it('writeCredential overwrites existing entry without affecting others', async () => {
    const { writeCredential, readCredentials } = await loadModule();
    writeCredential('a', { apiKey: 'key-a' });
    writeCredential('b', { apiKey: 'key-b' });
    writeCredential('a', { apiKey: 'key-a-updated' });

    const creds = readCredentials();
    assert.equal(creds.a?.apiKey, 'key-a-updated');
    assert.equal(creds.b?.apiKey, 'key-b');
  });

  it('deleteCredential removes entry', async () => {
    const { writeCredential, deleteCredential, readCredentials } = await loadModule();
    writeCredential('a', { apiKey: 'key-a' });
    writeCredential('b', { apiKey: 'key-b' });
    deleteCredential('a');

    const creds = readCredentials();
    assert.equal(creds.a, undefined);
    assert.equal(creds.b?.apiKey, 'key-b');
  });

  it('deleteCredential is a no-op for nonexistent ref', async () => {
    const { deleteCredential, readCredentials } = await loadModule();
    // Should not throw
    deleteCredential('nonexistent');
    assert.deepEqual(readCredentials(), {});
  });

  it('hasCredential returns correct boolean', async () => {
    const { writeCredential, hasCredential } = await loadModule();
    assert.equal(hasCredential('x'), false);
    writeCredential('x', { apiKey: 'key-x' });
    assert.equal(hasCredential('x'), true);
  });

  it('readCredential returns single entry or undefined', async () => {
    const { writeCredential, readCredential } = await loadModule();
    assert.equal(readCredential('missing'), undefined);
    writeCredential('found', { apiKey: 'key-found' });
    assert.deepEqual(readCredential('found'), { apiKey: 'key-found' });
  });

  it('preserves file permissions on subsequent writes', async () => {
    const { writeCredential, resolveCredentialsPath } = await loadModule();
    writeCredential('first', { apiKey: 'k1' });
    writeCredential('second', { apiKey: 'k2' });

    const credPath = resolveCredentialsPath();
    const fileStat = await stat(credPath);
    const mode = fileStat.mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('handles corrupt JSON gracefully', async () => {
    const { readCredentials, resolveCredentialsPath } = await loadModule();
    const credPath = resolveCredentialsPath();
    await mkdir(join(globalRoot, '.cat-cafe'), { recursive: true });
    await writeFile(credPath, 'NOT VALID JSON{{{', 'utf-8');

    const creds = readCredentials();
    assert.deepEqual(creds, {});
  });
});
