import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const {
  resolveEvidenceDbPath,
  resolveWorldDbPath,
  resolveTranscriptsDir,
  resolveAuditLogsDir,
  resolveCliRawArchiveDir,
  resolveUploadsDir,
  resolveCatCafeStateDir,
  resolveRedisDataDir,
  resolveRedisBackupDir,
  resolveTtsCacheDir,
  resolveConnectorMediaDir,
  resolveLogDir,
  describeDataPaths,
} = await import('../dist/config/data-dirs.js');

import { homedir } from 'node:os';

const REPO_ROOT = '/tmp/issue-671-repo';
const MONOREPO_ROOT = '/tmp/issue-671-monorepo';

const REDIS_ENV_KEYS = ['REDIS_DATA_DIR', 'REDIS_BACKUP_DIR'];

function snapshotEnv() {
  const snap = {
    DATA_DIR: process.env.DATA_DIR,
    CACHE_DIR: process.env.CACHE_DIR,
    LOG_DIR: process.env.LOG_DIR,
  };
  for (const k of REDIS_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  for (const key of Object.keys(snap)) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

function clearRoots() {
  delete process.env.DATA_DIR;
  delete process.env.CACHE_DIR;
  delete process.env.LOG_DIR;
  for (const k of REDIS_ENV_KEYS) delete process.env[k];
}

describe('data-dirs resolver (issue #671)', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    clearRoots();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  describe('legacy defaults (no root configured)', () => {
    test('evidence.sqlite falls back to repoRoot', () => {
      assert.equal(resolveEvidenceDbPath(REPO_ROOT), resolve(REPO_ROOT, 'evidence.sqlite'));
    });

    test('world.sqlite falls back to repoRoot', () => {
      assert.equal(resolveWorldDbPath(REPO_ROOT), resolve(REPO_ROOT, 'world.sqlite'));
    });

    test('transcripts falls back to monorepoRoot/data/transcripts', () => {
      assert.equal(resolveTranscriptsDir(MONOREPO_ROOT), resolve(MONOREPO_ROOT, 'data/transcripts'));
    });

    test('audit-logs falls back to cwd/data/audit-logs', () => {
      assert.equal(resolveAuditLogsDir(), resolve(process.cwd(), 'data/audit-logs'));
    });

    test('cli-raw-archive falls back to cwd/data/cli-raw-archive', () => {
      assert.equal(resolveCliRawArchiveDir(), resolve(process.cwd(), 'data/cli-raw-archive'));
    });

    test('uploads falls back to module-relative packages/api/uploads', () => {
      const dir = resolveUploadsDir();
      // Module default resolves to <pkg>/uploads at runtime (under dist/, two levels up = packages/api)
      assert.ok(dir.endsWith('/uploads'), `expected to end with /uploads, got ${dir}`);
      assert.ok(dir.includes('packages/api'), `expected to include packages/api, got ${dir}`);
    });

    test('tts-cache falls back to cwd/data/tts-cache', () => {
      assert.equal(resolveTtsCacheDir(), resolve(process.cwd(), 'data/tts-cache'));
    });

    test('connector-media falls back to cwd/data/connector-media', () => {
      assert.equal(resolveConnectorMediaDir(), resolve(process.cwd(), 'data/connector-media'));
    });

    test('logs falls back to cwd/data/logs/api', () => {
      assert.equal(resolveLogDir(), resolve(process.cwd(), 'data/logs/api'));
    });

    test('.cat-cafe state falls back to projectRoot/.cat-cafe', () => {
      assert.equal(resolveCatCafeStateDir(REPO_ROOT), resolve(REPO_ROOT, '.cat-cafe'));
    });

    test('redis data falls back to REDIS_DATA_DIR env or home default', () => {
      // No REDIS_DATA_DIR in env → homedir-based default
      const dir = resolveRedisDataDir();
      assert.equal(dir, resolve(homedir(), '.cat-cafe/redis-dev'));
    });

    test('redis data respects REDIS_DATA_DIR env when set', () => {
      process.env.REDIS_DATA_DIR = '/tmp/custom-redis';
      assert.equal(resolveRedisDataDir(), '/tmp/custom-redis');
      delete process.env.REDIS_DATA_DIR;
    });

    test('redis backups falls back to REDIS_BACKUP_DIR env or home default', () => {
      const dir = resolveRedisBackupDir();
      assert.equal(dir, resolve(homedir(), '.cat-cafe/redis-backups/dev'));
    });

    test('redis backups respects REDIS_BACKUP_DIR env when set', () => {
      process.env.REDIS_BACKUP_DIR = '/tmp/custom-redis-backups';
      assert.equal(resolveRedisBackupDir(), '/tmp/custom-redis-backups');
      delete process.env.REDIS_BACKUP_DIR;
    });
  });

  describe('DATA_DIR root configured', () => {
    beforeEach(() => {
      process.env.DATA_DIR = '/tmp/issue-671-data';
    });

    test('evidence.sqlite goes under DATA_DIR', () => {
      assert.equal(resolveEvidenceDbPath(REPO_ROOT), '/tmp/issue-671-data/evidence.sqlite');
    });

    test('world.sqlite goes under DATA_DIR', () => {
      assert.equal(resolveWorldDbPath(REPO_ROOT), '/tmp/issue-671-data/world.sqlite');
    });

    test('transcripts goes under DATA_DIR (overrides monorepoRoot)', () => {
      assert.equal(resolveTranscriptsDir(MONOREPO_ROOT), '/tmp/issue-671-data/transcripts');
    });

    test('audit-logs goes under DATA_DIR', () => {
      assert.equal(resolveAuditLogsDir(), '/tmp/issue-671-data/audit-logs');
    });

    test('cli-raw-archive goes under DATA_DIR', () => {
      assert.equal(resolveCliRawArchiveDir(), '/tmp/issue-671-data/cli-raw-archive');
    });

    test('uploads goes under DATA_DIR (overrides module default)', () => {
      assert.equal(resolveUploadsDir(), '/tmp/issue-671-data/uploads');
    });

    test('.cat-cafe state goes under DATA_DIR', () => {
      assert.equal(resolveCatCafeStateDir(REPO_ROOT), '/tmp/issue-671-data/cat-cafe');
    });

    test('redis data goes under DATA_DIR', () => {
      assert.equal(resolveRedisDataDir(), '/tmp/issue-671-data/redis');
    });

    test('redis backups goes under DATA_DIR', () => {
      assert.equal(resolveRedisBackupDir(), '/tmp/issue-671-data/redis-backups');
    });

    test('DATA_DIR overrides REDIS_DATA_DIR env', () => {
      process.env.REDIS_DATA_DIR = '/should/be/ignored';
      assert.equal(resolveRedisDataDir(), '/tmp/issue-671-data/redis');
      delete process.env.REDIS_DATA_DIR;
    });

    test('DATA_DIR does not affect cache or log paths', () => {
      assert.equal(resolveTtsCacheDir(), resolve(process.cwd(), 'data/tts-cache'));
      assert.equal(resolveLogDir(), resolve(process.cwd(), 'data/logs/api'));
    });
  });

  describe('CACHE_DIR root configured', () => {
    beforeEach(() => {
      process.env.CACHE_DIR = '/tmp/issue-671-cache';
    });

    test('tts-cache goes under CACHE_DIR', () => {
      assert.equal(resolveTtsCacheDir(), '/tmp/issue-671-cache/tts');
    });

    test('connector-media goes under CACHE_DIR', () => {
      assert.equal(resolveConnectorMediaDir(), '/tmp/issue-671-cache/connector-media');
    });

    test('CACHE_DIR does not affect data or log paths', () => {
      assert.equal(resolveEvidenceDbPath(REPO_ROOT), resolve(REPO_ROOT, 'evidence.sqlite'));
      assert.equal(resolveLogDir(), resolve(process.cwd(), 'data/logs/api'));
    });
  });

  describe('LOG_DIR root configured', () => {
    test('LOG_DIR is used directly without subdirectory', () => {
      process.env.LOG_DIR = '/tmp/issue-671-logs';
      assert.equal(resolveLogDir(), '/tmp/issue-671-logs');
    });
  });

  describe('empty/whitespace root values are treated as unset', () => {
    test('DATA_DIR="" falls back to legacy', () => {
      process.env.DATA_DIR = '';
      assert.equal(resolveEvidenceDbPath(REPO_ROOT), resolve(REPO_ROOT, 'evidence.sqlite'));
    });

    test('DATA_DIR="   " (whitespace) falls back to legacy', () => {
      process.env.DATA_DIR = '   ';
      assert.equal(resolveEvidenceDbPath(REPO_ROOT), resolve(REPO_ROOT, 'evidence.sqlite'));
    });

    test('LOG_DIR="" falls back to default', () => {
      process.env.LOG_DIR = '';
      assert.equal(resolveLogDir(), resolve(process.cwd(), 'data/logs/api'));
    });
  });

  describe('relative root paths are resolved against cwd', () => {
    test('DATA_DIR=./mydata becomes absolute', () => {
      process.env.DATA_DIR = './mydata';
      const expected = resolve(process.cwd(), 'mydata/evidence.sqlite');
      assert.equal(resolveEvidenceDbPath(REPO_ROOT), expected);
    });
  });

  describe('describeDataPaths introspection', () => {
    test('returns 12 specs with correct keys when no root set', () => {
      const specs = describeDataPaths({ repoRoot: REPO_ROOT, monorepoRoot: MONOREPO_ROOT });
      assert.equal(specs.length, 12);
      const keys = specs.map((s) => s.key).sort();
      assert.deepEqual(keys, [
        'auditLogs',
        'catCafeState',
        'cliRawArchive',
        'connectorMedia',
        'evidenceDb',
        'logs',
        'redisBackups',
        'redisData',
        'transcripts',
        'ttsCache',
        'uploads',
        'worldDb',
      ]);
      // No root → rootBasedPath is null for all
      for (const s of specs) {
        assert.equal(s.rootBasedPath, null, `expected rootBasedPath=null for ${s.key}`);
        assert.equal(s.currentPath, s.legacyPath, `expected currentPath=legacyPath for ${s.key}`);
      }
    });

    test('isFile flag is true only for SQLite DBs', () => {
      const specs = describeDataPaths({ repoRoot: REPO_ROOT, monorepoRoot: MONOREPO_ROOT });
      const fileKeys = specs
        .filter((s) => s.isFile)
        .map((s) => s.key)
        .sort();
      assert.deepEqual(fileKeys, ['evidenceDb', 'worldDb']);
    });

    test('with all roots set, rootBasedPath equals currentPath', () => {
      process.env.DATA_DIR = '/tmp/d';
      process.env.CACHE_DIR = '/tmp/c';
      process.env.LOG_DIR = '/tmp/l';
      const specs = describeDataPaths({ repoRoot: REPO_ROOT, monorepoRoot: MONOREPO_ROOT });
      for (const s of specs) {
        assert.notEqual(s.rootBasedPath, null, `expected rootBasedPath set for ${s.key}`);
        assert.equal(s.currentPath, s.rootBasedPath, `mismatch for ${s.key}`);
      }
      // Spot check sub-paths
      const evidence = specs.find((s) => s.key === 'evidenceDb');
      assert.equal(evidence.currentPath, '/tmp/d/evidence.sqlite');
      const tts = specs.find((s) => s.key === 'ttsCache');
      assert.equal(tts.currentPath, '/tmp/c/tts');
      const logs = specs.find((s) => s.key === 'logs');
      assert.equal(logs.currentPath, '/tmp/l');
      assert.equal(logs.subPath, '', 'logs subPath should be empty');
    });
  });
});
