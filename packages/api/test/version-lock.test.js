import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildLockVersion } from '../dist/config/capabilities/version-lock.js';

describe('VersionLock', () => {
  test('builds lock from marketplace source', () => {
    const lock = buildLockVersion({
      source: 'marketplace',
      version: '1.2.3',
      channel: 'stable',
      installedBy: 'opus',
    });
    assert.strictEqual(lock.source, 'marketplace');
    assert.strictEqual(lock.version, '1.2.3');
    assert.strictEqual(lock.channel, 'stable');
    assert.strictEqual(lock.installedBy, 'opus');
  });

  test('installedAt is valid ISO8601', () => {
    const lock = buildLockVersion({
      source: 'npm',
      version: '2.0.0',
      installedBy: 'user',
    });
    assert.ok(!Number.isNaN(Date.parse(lock.installedAt)));
  });

  test('local source omits channel', () => {
    const lock = buildLockVersion({
      source: 'local',
      version: '0.0.0',
      installedBy: 'user',
    });
    assert.strictEqual(lock.channel, undefined);
  });

  test('git source includes version hash', () => {
    const lock = buildLockVersion({
      source: 'git',
      version: 'abc1234',
      installedBy: 'codex',
    });
    assert.strictEqual(lock.source, 'git');
    assert.strictEqual(lock.version, 'abc1234');
  });

  test('version is required', () => {
    assert.throws(() => buildLockVersion({ source: 'npm', version: '', installedBy: 'user' }), /version.*required/i);
  });
});
