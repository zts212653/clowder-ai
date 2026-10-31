import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isSanctuaryRedisUrl, loadCatIdAllowlistFromConfig, parseMintArgs } from '../../src/scripts/mint-agent-key.js';

// ============ parseMintArgs ============

describe('parseMintArgs', () => {
  it('rejects missing --cat-id', () => {
    const r = parseMintArgs(['--redis-url', 'redis://127.0.0.1:6398']);
    assert.equal('error' in r, true);
    if ('error' in r) assert.match(r.error, /--cat-id/);
  });

  it('rejects missing --redis-url with helpful message about silent 6399 hit', () => {
    const r = parseMintArgs(['--cat-id', 'fable-5']);
    assert.equal('error' in r, true);
    if ('error' in r) assert.match(r.error, /--redis-url.*no default.*6399/);
  });

  it('rejects positional args', () => {
    const r = parseMintArgs(['fable-5', '--redis-url', 'redis://127.0.0.1:6398']);
    assert.equal('error' in r, true);
    if ('error' in r) assert.match(r.error, /Unexpected positional/);
  });

  it('rejects flag missing value', () => {
    const r = parseMintArgs(['--cat-id']);
    assert.equal('error' in r, true);
    if ('error' in r) assert.match(r.error, /Missing value for --cat-id/);
  });

  it('rejects unknown flag (codex review §P2)', () => {
    const r = parseMintArgs(['--cat-id', 'fable-5', '--redis-url', 'redis://127.0.0.1:6398', '--unknown-flag', 'oops']);
    assert.equal('error' in r, true);
    if ('error' in r) assert.match(r.error, /Unknown flag: --unknown-flag/);
  });

  it('rejects unknown boolean-looking flag', () => {
    const r = parseMintArgs(['--cat-id', 'fable-5', '--redis-url', 'redis://127.0.0.1:6398', '--nuke-everything']);
    assert.equal('error' in r, true);
    if ('error' in r) assert.match(r.error, /Unknown flag: --nuke-everything/);
  });

  it('defaults execute=false (dry-run forced absent flag)', () => {
    const r = parseMintArgs(['--cat-id', 'fable-5', '--redis-url', 'redis://127.0.0.1:6398']);
    assert.equal('error' in r, false);
    if (!('error' in r)) assert.equal(r.execute, false);
  });

  it('parses --execute flag (boolean)', () => {
    const r = parseMintArgs(['--cat-id', 'fable-5', '--redis-url', 'redis://127.0.0.1:6398', '--execute']);
    assert.equal('error' in r, false);
    if (!('error' in r)) assert.equal(r.execute, true);
  });

  it('parses --i-understand-runtime-redis flag (boolean)', () => {
    const r = parseMintArgs([
      '--cat-id',
      'fable-5',
      '--redis-url',
      'redis://127.0.0.1:6399',
      '--i-understand-runtime-redis',
    ]);
    assert.equal('error' in r, false);
    if (!('error' in r)) assert.equal(r.iUnderstandRuntimeRedis, true);
  });

  it('defaults user-id to "default-user"', () => {
    const r = parseMintArgs(['--cat-id', 'fable-5', '--redis-url', 'redis://127.0.0.1:6398']);
    if (!('error' in r)) assert.equal(r.userId, 'default-user');
  });

  it('defaults key-file to ~/.cat-cafe/agent-keys/<catId>.secret', () => {
    const r = parseMintArgs(['--cat-id', 'fable-5', '--redis-url', 'redis://127.0.0.1:6398']);
    if (!('error' in r)) assert.match(r.keyFile, /\.cat-cafe\/agent-keys\/fable-5\.secret$/);
  });
});

// ============ isSanctuaryRedisUrl ============

describe('isSanctuaryRedisUrl — production Redis (sacred) detector', () => {
  it('true for redis://127.0.0.1:6399', () => {
    assert.equal(isSanctuaryRedisUrl('redis://127.0.0.1:6399'), true);
  });

  it('true for redis://localhost:6399', () => {
    assert.equal(isSanctuaryRedisUrl('redis://localhost:6399'), true);
  });

  it('true for redis://[::1]:6399', () => {
    assert.equal(isSanctuaryRedisUrl('redis://[::1]:6399'), true);
  });

  it('false for redis://127.0.0.1:6398 (worktree port)', () => {
    assert.equal(isSanctuaryRedisUrl('redis://127.0.0.1:6398'), false);
  });

  it('false for redis://127.0.0.1 (no port = default 6379)', () => {
    assert.equal(isSanctuaryRedisUrl('redis://127.0.0.1'), false);
  });

  it('true for redis://192.168.1.5:6399 (non-loopback host — cloud-review P1)', () => {
    // cloud codex review 2026-06-13 P1: ack must gate ANY 6399 URL, not just
    // loopback. Runtime sanctuary Redis may be reachable via DNS alias.
    assert.equal(isSanctuaryRedisUrl('redis://192.168.1.5:6399'), true);
  });

  it('true for redis://redis.cat-cafe.internal:6399 (runtime DNS alias — cloud-review P1)', () => {
    assert.equal(isSanctuaryRedisUrl('redis://redis.cat-cafe.internal:6399'), true);
  });

  it('false for invalid URL', () => {
    assert.equal(isSanctuaryRedisUrl('not-a-url'), false);
  });
});

// ============ loadCatIdAllowlistFromConfig — real cat-config.json ============

describe('loadCatIdAllowlistFromConfig — real repo config', () => {
  it('loads roster keys including fable-5 from repo cat-config.json', async () => {
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '../../../../');
    const configPath = resolve(repoRoot, 'cat-config.json');
    const allowlist = await loadCatIdAllowlistFromConfig(configPath);
    assert.equal(allowlist.has('fable-5'), true, 'fable-5 must be in roster');
    assert.equal(allowlist.has('opus-47'), true);
    assert.equal(allowlist.has('codex'), true);
    assert.equal(allowlist.has('bogus-cat-12345'), false);
  });
});
