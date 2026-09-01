import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const { buildMigrationPlan, measurePath, runDataDirsMigration, shouldAbortStartupOnMigration } = await import(
  '../dist/config/data-dirs-migration.js'
);

function snapshotEnv() {
  return {
    DATA_DIR: process.env.DATA_DIR,
    CACHE_DIR: process.env.CACHE_DIR,
    LOG_DIR: process.env.LOG_DIR,
  };
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
}

function plentyOfSpaceIO() {
  return {
    diskFree: async () => ({ availableBytes: 1_000_000_000_000, totalBytes: 2_000_000_000_000 }),
  };
}

function squeezedSpaceIO(availableBytes) {
  return {
    diskFree: async () => ({ availableBytes, totalBytes: availableBytes * 2 }),
  };
}

describe('data-dirs-migration', () => {
  let savedEnv;
  let workRoot;

  beforeEach(async () => {
    savedEnv = snapshotEnv();
    clearRoots();
    workRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-671-mig-'));
  });

  afterEach(async () => {
    restoreEnv(savedEnv);
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  describe('buildMigrationPlan', () => {
    test('reports no work when no root env var is set', async () => {
      const plan = await buildMigrationPlan({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
      });
      assert.equal(plan.hasWork, false);
      assert.equal(plan.totalBytes, 0);
      const reasons = new Set(plan.items.map((i) => i.skipReason));
      assert.ok(reasons.has('root-env-not-set'));
    });

    test('skips items with no source data', async () => {
      // chdir to a clean dir so cwd-relative legacy paths (audit-logs, cli-raw-archive)
      // don't see leftover data from prior test runs in the project root.
      const cleanCwd = await mkdtemp(join(tmpdir(), 'cat-cafe-671-cwd-'));
      const originalCwd = process.cwd();
      process.chdir(cleanCwd);
      try {
        process.env.DATA_DIR = join(workRoot, 'data');
        const plan = await buildMigrationPlan({
          repoRoot: workRoot,
          monorepoRoot: workRoot,
          uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        });
        assert.equal(plan.hasWork, false);
        for (const item of plan.items) {
          if (item.spec.root === 'DATA_DIR') {
            assert.ok(['no-source-data', 'legacy-equals-target'].includes(item.skipReason));
          }
        }
      } finally {
        process.chdir(originalCwd);
        await rm(cleanCwd, { recursive: true, force: true });
      }
    });

    test('detects eligible items with source data + empty target', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'fake sqlite content', 'utf-8');
      process.env.DATA_DIR = join(workRoot, 'data');

      const plan = await buildMigrationPlan({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
      });
      assert.equal(plan.hasWork, true);
      const evidence = plan.items.find((i) => i.spec.key === 'evidenceDb');
      assert.ok(evidence);
      assert.equal(evidence.eligible, true);
      assert.ok(evidence.sourceBytes > 0);
    });

    test('skips items where target is already populated', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'fake', 'utf-8');
      const targetDb = join(workRoot, 'data', 'evidence.sqlite');
      await mkdir(join(workRoot, 'data'), { recursive: true });
      await writeFile(targetDb, 'existing target content', 'utf-8');

      process.env.DATA_DIR = join(workRoot, 'data');
      const plan = await buildMigrationPlan({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
      });
      const evidence = plan.items.find((i) => i.spec.key === 'evidenceDb');
      assert.equal(evidence.eligible, false);
      assert.equal(evidence.skipReason, 'target-not-empty');
    });

    test('treats populated SQLite target sidecars as target-not-empty', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'legacy main', 'utf-8');
      const dataRoot = join(workRoot, 'data');
      await mkdir(dataRoot, { recursive: true });
      await writeFile(join(dataRoot, 'evidence.sqlite-wal'), 'target wal', 'utf-8');

      process.env.DATA_DIR = dataRoot;
      const plan = await buildMigrationPlan({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
      });
      const evidence = plan.items.find((i) => i.spec.key === 'evidenceDb');
      assert.equal(evidence.eligible, false);
      assert.equal(evidence.targetPopulated, true);
      assert.equal(evidence.skipReason, 'target-not-empty');
    });

    test('treats uploads legacy .gitkeep placeholder as no source data', async () => {
      const legacyUploads = join(workRoot, 'packages', 'api', 'uploads');
      const dataRoot = join(workRoot, 'data');
      await mkdir(legacyUploads, { recursive: true });
      await mkdir(join(dataRoot, 'uploads'), { recursive: true });
      await writeFile(join(legacyUploads, '.gitkeep'), '', 'utf-8');
      await writeFile(join(dataRoot, 'uploads', 'real-upload.png'), 'target upload', 'utf-8');

      process.env.DATA_DIR = dataRoot;
      const plan = await buildMigrationPlan({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: legacyUploads,
      });

      const uploads = plan.items.find((i) => i.spec.key === 'uploads');
      assert.equal(uploads.eligible, false);
      assert.equal(uploads.sourceExists, false);
      assert.equal(uploads.skipReason, 'no-source-data');
    });
  });

  describe('measurePath', () => {
    test('returns 0 for missing paths', async () => {
      assert.equal(await measurePath('/tmp/this-does-not-exist-671'), 0);
    });

    test('returns file size for plain files', async () => {
      const file = join(workRoot, 'sample.txt');
      await writeFile(file, 'abcdef', 'utf-8');
      assert.equal(await measurePath(file), 6);
    });

    test('includes SQLite sidecars (-wal, -shm) for *.sqlite files', async () => {
      const db = join(workRoot, 'evidence.sqlite');
      await writeFile(db, '1234567890', 'utf-8'); // 10 bytes
      await writeFile(`${db}-wal`, '12345', 'utf-8'); // 5 bytes
      await writeFile(`${db}-shm`, 'XX', 'utf-8'); // 2 bytes
      assert.equal(await measurePath(db), 17);
    });

    test('recursively sums directory contents', async () => {
      const dir = join(workRoot, 'tree');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf-8'); // 5
      await writeFile(join(dir, 'sub', 'b.txt'), 'world!', 'utf-8'); // 6
      assert.equal(await measurePath(dir), 11);
    });
  });

  describe('runDataDirsMigration', () => {
    test('returns attempted=false when no work pending', async () => {
      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });
      assert.equal(result.attempted, false);
      assert.equal(result.allSucceeded, true);
      assert.equal(result.restartRecommended, false);
    });

    test('migrates eligible file paths and SQLite sidecars', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'evidence-data', 'utf-8');
      await writeFile(`${legacyDb}-wal`, 'wal-data', 'utf-8');
      await writeFile(`${legacyDb}-shm`, 'shm-data', 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      process.env.DATA_DIR = dataRoot;

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });

      assert.equal(result.attempted, true);
      const evidence = result.items.find((i) => i.key === 'evidenceDb');
      assert.ok(evidence);
      assert.equal(evidence.status, 'moved');

      // New paths exist with content
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite')), true);
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite-wal')), true);
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite-shm')), true);
      assert.equal(await readFile(join(dataRoot, 'evidence.sqlite'), 'utf-8'), 'evidence-data');

      // Legacy paths cleaned up
      assert.equal(existsSync(legacyDb), false);
      assert.equal(existsSync(`${legacyDb}-wal`), false);
      assert.equal(existsSync(`${legacyDb}-shm`), false);
    });

    test('rolls back main SQLite file when sidecar migration fails', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      const legacyWal = `${legacyDb}-wal`;
      await writeFile(legacyDb, 'main-db-data', 'utf-8');
      await writeFile(legacyWal, 'wal-data', 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      await mkdir(dataRoot, { recursive: true });
      // Plant a directory at the WAL target path — rename(file, dir) fails
      // with EISDIR, triggering the rollback logic in migrateOne.
      await mkdir(join(dataRoot, 'evidence.sqlite-wal'), { recursive: true });

      process.env.DATA_DIR = dataRoot;

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });

      const evidence = result.items.find((i) => i.key === 'evidenceDb');
      assert.equal(evidence.status, 'failed', 'migration must fail when sidecar target is blocked');
      // Legacy data must be fully intact (rollback succeeded)
      assert.equal(existsSync(legacyDb), true, 'legacy main DB must survive rollback');
      assert.equal(existsSync(legacyWal), true, 'legacy WAL must survive rollback');
      assert.equal(await readFile(legacyDb, 'utf-8'), 'main-db-data');
      assert.equal(await readFile(legacyWal, 'utf-8'), 'wal-data');
      // Target main file must NOT remain (rolled back)
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite')), false, 'target main DB must be rolled back');
    });

    test('migrates eligible directory paths recursively', async () => {
      // Set up legacy audit-logs dir relative to workRoot (acts as cwd surrogate)
      const legacyAudit = join(workRoot, 'data', 'audit-logs');
      await mkdir(legacyAudit, { recursive: true });
      await writeFile(join(legacyAudit, 'audit-2026-01-01.ndjson'), '{"a":1}\n', 'utf-8');
      await writeFile(join(legacyAudit, 'audit-2026-01-02.ndjson'), '{"b":2}\n', 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      process.env.DATA_DIR = dataRoot;

      // Temporarily run from workRoot so cwd-relative legacy resolves correctly
      const originalCwd = process.cwd();
      process.chdir(workRoot);
      try {
        const result = await runDataDirsMigration({
          repoRoot: workRoot,
          monorepoRoot: workRoot,
          uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
          trigger: 'startup',
          io: plentyOfSpaceIO(),
        });
        assert.equal(result.attempted, true);
        const audit = result.items.find((i) => i.key === 'auditLogs');
        assert.equal(audit.status, 'moved');
        assert.equal(existsSync(join(dataRoot, 'audit-logs', 'audit-2026-01-01.ndjson')), true);
        assert.equal(existsSync(join(dataRoot, 'audit-logs', 'audit-2026-01-02.ndjson')), true);
        assert.equal(existsSync(legacyAudit), false);
      } finally {
        process.chdir(originalCwd);
      }
    });

    test('aborts when disk space is insufficient — no partial moves', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'x'.repeat(1000), 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      process.env.DATA_DIR = dataRoot;

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'startup',
        io: squeezedSpaceIO(500), // need ~1500, only have 500
      });

      assert.equal(result.attempted, false);
      assert.ok(result.abortedReason?.includes('insufficient-disk-space'));
      assert.equal(existsSync(legacyDb), true, 'legacy file must remain untouched on abort');
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite')), false);
    });

    test('recommends restart only for runtime trigger', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'data', 'utf-8');
      process.env.DATA_DIR = join(workRoot, 'newdata');

      const startup = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });
      assert.equal(startup.restartRecommended, false);

      // Reset by moving file back
      await writeFile(legacyDb, 'data', 'utf-8');
      await rm(join(workRoot, 'newdata'), { recursive: true, force: true });

      const runtime = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'runtime',
        io: plentyOfSpaceIO(),
      });
      assert.equal(runtime.restartRecommended, true);
    });

    test('blockFileMoves refuses runtime SQLite moves without touching legacy data', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'legacy evidence', 'utf-8');
      process.env.DATA_DIR = join(workRoot, 'newdata');

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'runtime',
        blockFileMoves: true,
        io: plentyOfSpaceIO(),
      });

      assert.equal(result.attempted, false);
      assert.equal(result.allSucceeded, false);
      assert.equal(result.restartRecommended, true);
      assert.match(result.abortedReason, /restart/i);
      const evidence = result.items.find((i) => i.key === 'evidenceDb');
      assert.equal(evidence.status, 'skipped');
      assert.equal(evidence.reason, 'runtime-file-migration-requires-restart');
      assert.equal(existsSync(legacyDb), true);
      assert.equal(existsSync(join(workRoot, 'newdata', 'evidence.sqlite')), false);
    });

    test('shouldAbortStartupOnMigration: no work → no abort', () => {
      const decision = shouldAbortStartupOnMigration({
        attempted: false,
        items: [],
        allSucceeded: true,
        restartRecommended: false,
      });
      assert.equal(decision.shouldAbort, false);
    });

    test('shouldAbortStartupOnMigration: all moved → no abort', () => {
      const decision = shouldAbortStartupOnMigration({
        attempted: true,
        items: [
          { key: 'evidenceDb', fromPath: '/old/e', toPath: '/new/e', bytes: 10, status: 'moved' },
          { key: 'worldDb', fromPath: '/old/w', toPath: '/new/w', bytes: 10, status: 'moved' },
        ],
        allSucceeded: true,
        restartRecommended: false,
      });
      assert.equal(decision.shouldAbort, false);
    });

    test('shouldAbortStartupOnMigration: aborted at planning stage → abort', () => {
      const decision = shouldAbortStartupOnMigration({
        attempted: false,
        items: [],
        allSucceeded: false,
        restartRecommended: false,
        abortedReason: 'insufficient-disk-space: need 1000, have 500',
      });
      assert.equal(decision.shouldAbort, true);
      assert.ok(decision.reason.includes('insufficient-disk-space'));
    });

    test('shouldAbortStartupOnMigration: per-item failure → abort with leftBehind list', () => {
      const decision = shouldAbortStartupOnMigration({
        attempted: true,
        items: [
          { key: 'evidenceDb', fromPath: '/old/e', toPath: '/new/e', bytes: 10, status: 'moved' },
          { key: 'worldDb', fromPath: '/old/w', toPath: '/new/w', bytes: 10, status: 'failed', error: 'EACCES' },
          {
            key: 'auditLogs',
            fromPath: '/old/a',
            toPath: '/new/a',
            bytes: 0,
            status: 'skipped',
            reason: 'no-source-data',
          },
        ],
        allSucceeded: false,
        restartRecommended: false,
      });
      assert.equal(decision.shouldAbort, true);
      assert.ok(decision.reason.includes('1 data-dirs path(s) failed'));
      assert.equal(decision.leftBehind.length, 1);
      assert.equal(decision.leftBehind[0].key, 'worldDb');
      assert.equal(decision.leftBehind[0].status, 'failed');
    });

    test('shouldAbortStartupOnMigration: only skipped items → no abort', () => {
      const decision = shouldAbortStartupOnMigration({
        attempted: true,
        items: [
          {
            key: 'evidenceDb',
            fromPath: '/old/e',
            toPath: '/old/e',
            bytes: 0,
            status: 'skipped',
            reason: 'no-source-data',
          },
        ],
        allSucceeded: true,
        restartRecommended: false,
      });
      assert.equal(decision.shouldAbort, false);
    });

    test('startup surfaces target-not-empty blocked migrations when no item is eligible', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'legacy evidence', 'utf-8');
      const dataRoot = join(workRoot, 'newdata');
      await mkdir(dataRoot, { recursive: true });
      await writeFile(join(dataRoot, 'evidence.sqlite'), 'existing target', 'utf-8');
      process.env.DATA_DIR = dataRoot;

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });

      assert.equal(result.attempted, false);
      assert.equal(result.allSucceeded, false);
      const evidence = result.items.find((i) => i.key === 'evidenceDb');
      assert.equal(evidence.status, 'skipped');
      assert.equal(evidence.reason, 'target-not-empty');

      const decision = shouldAbortStartupOnMigration(result);
      assert.equal(decision.shouldAbort, true);
      assert.ok(decision.reason.includes('target-not-empty'));
      assert.equal(decision.leftBehind.length, 1);
      assert.equal(decision.leftBehind[0].key, 'evidenceDb');
      assert.equal(decision.leftBehind[0].status, 'skipped');
    });

    test('cross-device dir migration fails on symlinks instead of silently dropping them', async () => {
      // Create a data directory containing a symlink
      const legacyAudit = join(workRoot, 'data', 'audit-logs');
      await mkdir(legacyAudit, { recursive: true });
      await writeFile(join(legacyAudit, 'real.ndjson'), '{"a":1}\n', 'utf-8');
      // Create a relative symlink inside the directory (relative so it
      // survives same-device rename to a different parent directory)
      await symlink('real.ndjson', join(legacyAudit, 'link.ndjson'));

      const dataRoot = join(workRoot, 'newdata');
      process.env.DATA_DIR = dataRoot;

      const originalCwd = process.cwd();
      process.chdir(workRoot);
      try {
        const result = await runDataDirsMigration({
          repoRoot: workRoot,
          monorepoRoot: workRoot,
          uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
          trigger: 'startup',
          io: plentyOfSpaceIO(),
        });
        // On same device, rename handles symlinks transparently → moved.
        // The test checks that the migration either succeeds (same device)
        // or fails with a clear error (cross device), never silently drops.
        const audit = result.items.find((i) => i.key === 'auditLogs');
        if (audit.status === 'moved') {
          // Same-device rename succeeded — symlink preserved
          assert.equal(existsSync(join(dataRoot, 'audit-logs', 'link.ndjson')), true);
        } else {
          // Cross-device path hit the symlink guard → failed with message
          assert.equal(audit.status, 'failed');
          assert.ok(audit.error.includes('non-regular entry'));
          // Legacy data stays intact
          assert.equal(existsSync(join(legacyAudit, 'real.ndjson')), true);
          assert.equal(existsSync(join(legacyAudit, 'link.ndjson')), true);
        }
      } finally {
        process.chdir(originalCwd);
      }
    });

    test('cross-device dir migration removes partial target when copy fails', async () => {
      const legacyAudit = join(workRoot, 'data', 'audit-logs');
      await mkdir(legacyAudit, { recursive: true });
      await writeFile(join(legacyAudit, 'first.ndjson'), '{"first":true}\n', 'utf-8');
      await symlink('first.ndjson', join(legacyAudit, 'link.ndjson'));

      const dataRoot = join(workRoot, 'newdata');
      process.env.DATA_DIR = dataRoot;

      const originalCwd = process.cwd();
      process.chdir(workRoot);
      try {
        const result = await runDataDirsMigration({
          repoRoot: workRoot,
          monorepoRoot: workRoot,
          uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
          trigger: 'startup',
          io: plentyOfSpaceIO(),
          forceCrossDeviceForTesting: true,
        });
        const audit = result.items.find((i) => i.key === 'auditLogs');
        assert.equal(audit.status, 'failed');
        assert.ok(audit.error.includes('non-regular entry'));
        assert.equal(existsSync(join(legacyAudit, 'first.ndjson')), true, 'legacy file must remain');
        assert.equal(existsSync(join(legacyAudit, 'link.ndjson')), true, 'legacy symlink must remain');
        assert.equal(existsSync(join(dataRoot, 'audit-logs')), false, 'partial target must be removed');
      } finally {
        process.chdir(originalCwd);
      }
    });

    test('continues other items when one fails (per-item isolation)', async () => {
      const legacyA = join(workRoot, 'evidence.sqlite');
      const legacyB = join(workRoot, 'world.sqlite');
      await writeFile(legacyA, 'a-data', 'utf-8');
      await writeFile(legacyB, 'b-data', 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      // Pre-create the evidence target as a populated file → forces target-not-empty
      // for evidence, world should still migrate.
      await mkdir(dataRoot, { recursive: true });
      await writeFile(join(dataRoot, 'evidence.sqlite'), 'existing', 'utf-8');
      process.env.DATA_DIR = dataRoot;

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        uploadsLegacyOverride: join(workRoot, 'mock-uploads-legacy'),
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });
      assert.equal(result.attempted, true);
      const evidence = result.items.find((i) => i.key === 'evidenceDb');
      const world = result.items.find((i) => i.key === 'worldDb');
      assert.equal(evidence.status, 'skipped');
      assert.equal(evidence.reason, 'target-not-empty');
      assert.equal(world.status, 'moved');
      assert.equal(existsSync(join(dataRoot, 'world.sqlite')), true);
      assert.equal(existsSync(legacyB), false);
      // The pre-existing target evidence stays intact
      assert.equal(await readFile(join(dataRoot, 'evidence.sqlite'), 'utf-8'), 'existing');
    });
  });
});
