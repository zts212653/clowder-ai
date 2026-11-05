const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, test } = require('node:test');
const { compareRedisDirectory } = require('./redis-directory-diagnostic');

const root = mkdtempSync(join(tmpdir(), 'clowder-redis-directory-diagnostic-'));
const expected = join(root, 'desktop', 'data', 'redis');
const other = join(root, 'previous', 'data', 'redis');
mkdirSync(expected, { recursive: true });
mkdirSync(other, { recursive: true });

after(() => rmSync(root, { recursive: true, force: true }));

test('distinguishes matching and different data directories', () => {
  assert.equal(compareRedisDirectory(expected, ['dir', expected]), 'directory_matches');
  assert.equal(compareRedisDirectory(expected, ['dir', other]), 'directory_mismatch');
});

test('canonicalizes a directory alias before comparing', () => {
  const alias = join(root, 'linked redis');
  symlinkSync(expected, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(compareRedisDirectory(expected, ['dir', alias]), 'directory_matches');
});

test('recognizes the drive path reported by the Windows Redis build', { skip: process.platform !== 'win32' }, () => {
  const reported = expected.replace(/^([a-z]):\\/i, '/cygdrive/$1/').replaceAll('\\', '/');
  assert.equal(compareRedisDirectory(expected, ['dir', reported]), 'directory_matches');
});

test('an unavailable, non-local or malformed directory is inconclusive', () => {
  for (const response of [null, ['dir', 'relative'], ['dir', join(root, 'missing')], ['dbfilename', other]]) {
    assert.equal(compareRedisDirectory(expected, response), 'directory_unknown');
  }
  assert.equal(compareRedisDirectory(join(root, 'missing'), ['dir', other]), 'directory_unknown');
});
