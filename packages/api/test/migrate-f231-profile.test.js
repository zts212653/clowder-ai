import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const mod = await import('../dist/scripts/migrate-f231-profile.js');

describe('F231 profile migration', () => {
  let tmp;
  let dataDir;
  let sourceRoot;
  let runtimeRoot;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'f231-migration-'));
    dataDir = join(tmp, 'data');
    sourceRoot = join(tmp, 'source-profile');
    runtimeRoot = join(tmp, 'runtime-profile');
    mkdirSync(join(sourceRoot, 'relationship'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'relationship'), { recursive: true });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const options = (extra = {}) => ({
    legacyRoots: [sourceRoot, runtimeRoot],
    dataDir,
    userId: 'you',
    relationshipKeys: { codex: 'maine-coon', 'codex-sol': 'maine-coon', opus: 'ragdoll' },
    ...extra,
  });

  it('dry-run reports every conflicting source hash and writes nothing', () => {
    writeFileSync(join(sourceRoot, 'relationship', 'codex-primer.md'), 'OLD');
    writeFileSync(join(runtimeRoot, 'relationship', 'codex-sol-primer.md'), 'APPROVED');

    const manifest = mod.runProfileMigration(options());

    assert.equal(manifest.mode, 'dry-run');
    assert.equal(manifest.status, 'blocked');
    assert.equal(manifest.conflicts.length, 1);
    assert.equal(manifest.conflicts[0].targetPath, 'relationship/maine-coon-primer.md');
    assert.deepEqual(
      manifest.conflicts[0].candidates.map((candidate) => candidate.sha256).sort(),
      [mod.hashContent('OLD'), mod.hashContent('APPROVED')].sort(),
    );
    assert.equal(existsSync(join(dataDir, 'profiles', 'you')), false);
    assert.equal(existsSync(join(dataDir, 'profile-migration-backups')), false);
    assert.equal(existsSync(join(sourceRoot, '.migrated-to-cat-cafe-data-dir.json')), false);
  });

  it('apply fails closed on an unresolved conflict before backup or canonical writes', () => {
    writeFileSync(join(sourceRoot, 'relationship', 'codex-primer.md'), 'OLD');
    writeFileSync(join(runtimeRoot, 'relationship', 'codex-sol-primer.md'), 'APPROVED');

    assert.throws(() => mod.runProfileMigration(options({ apply: true })), /unresolved profile migration conflicts/i);
    assert.equal(existsSync(join(dataDir, 'profiles', 'you')), false);
    assert.equal(existsSync(join(dataDir, 'profile-migration-backups')), false);
  });

  it('fails closed when a legacy profile tree contains a symbolic link', () => {
    const outsidePrimer = join(tmp, 'outside-primer.md');
    writeFileSync(outsidePrimer, 'STRANDED');
    symlinkSync(outsidePrimer, join(sourceRoot, 'relationship', 'codex-primer.md'));

    assert.throws(() => mod.runProfileMigration(options()), /symbolic link.*codex-primer\.md/i);
  });

  it('hash-guarded resolution applies only after backup and writes legacy markers', () => {
    const oldPath = join(sourceRoot, 'relationship', 'codex-primer.md');
    const approvedPath = join(runtimeRoot, 'relationship', 'codex-sol-primer.md');
    writeFileSync(oldPath, 'OLD');
    writeFileSync(approvedPath, 'APPROVED');
    const mergedPath = join(tmp, 'merged.md');
    writeFileSync(mergedPath, 'MERGED');
    const resolutionFile = join(tmp, 'resolution.json');
    writeFileSync(
      resolutionFile,
      JSON.stringify({
        version: 1,
        resolutions: {
          'relationship/maine-coon-primer.md': {
            contentFile: mergedPath,
            expectedSourceHashes: [mod.hashContent('OLD'), mod.hashContent('APPROVED')].sort(),
          },
        },
      }),
    );

    const result = mod.runProfileMigration(options({ apply: true, resolutionFile }));

    assert.equal(result.status, 'applied');
    assert.equal(
      readFileSync(join(dataDir, 'profiles', 'you', 'relationship', 'maine-coon-primer.md'), 'utf8'),
      'MERGED',
    );
    assert.ok(result.backupDir);
    assert.equal(existsSync(join(result.backupDir, 'migration-backup.json')), true);
    assert.equal(readFileSync(join(result.backupDir, 'legacy-0', 'relationship', 'codex-primer.md'), 'utf8'), 'OLD');
    assert.equal(
      readFileSync(join(result.backupDir, 'legacy-1', 'relationship', 'codex-sol-primer.md'), 'utf8'),
      'APPROVED',
    );
    assert.equal(existsSync(join(sourceRoot, '.migrated-to-cat-cafe-data-dir.json')), true);
    assert.equal(existsSync(join(runtimeRoot, '.migrated-to-cat-cafe-data-dir.json')), true);
    const repeated = mod.runProfileMigration(options({ apply: true, resolutionFile }));
    assert.equal(repeated.status, 'noop', 'resolved conflict migration must also be idempotent');
    assert.equal(repeated.backupDir, result.backupDir);
  });

  it('recovers a resolved conflict when marker writing fails after canonical writes', () => {
    writeFileSync(join(sourceRoot, 'relationship', 'codex-primer.md'), 'OLD');
    writeFileSync(join(runtimeRoot, 'relationship', 'codex-sol-primer.md'), 'APPROVED');
    const canonical = join(dataDir, 'profiles', 'you', 'relationship', 'maine-coon-primer.md');
    mkdirSync(join(dataDir, 'profiles', 'you', 'relationship'), { recursive: true });
    writeFileSync(canonical, 'CANONICAL BEFORE');
    const mergedPath = join(tmp, 'merged.md');
    writeFileSync(mergedPath, 'MERGED');
    const resolutionFile = join(tmp, 'resolution.json');
    writeFileSync(
      resolutionFile,
      JSON.stringify({
        version: 1,
        resolutions: {
          'relationship/maine-coon-primer.md': {
            contentFile: mergedPath,
            expectedSourceHashes: [
              mod.hashContent('OLD'),
              mod.hashContent('APPROVED'),
              mod.hashContent('CANONICAL BEFORE'),
            ].sort(),
          },
        },
      }),
    );

    assert.throws(
      () =>
        mod.runProfileMigration(
          options({
            apply: true,
            resolutionFile,
            beforeMarkerWrite: (_markerPath, index) => {
              if (index === 1) throw new Error('simulated marker write failure');
            },
          }),
        ),
      /simulated marker write failure/,
    );
    assert.equal(readFileSync(canonical, 'utf8'), 'MERGED');
    assert.equal(existsSync(join(sourceRoot, '.migrated-to-cat-cafe-data-dir.json')), true);
    assert.equal(existsSync(join(runtimeRoot, '.migrated-to-cat-cafe-data-dir.json')), false);

    const recovered = mod.runProfileMigration(options({ apply: true, resolutionFile }));

    assert.equal(recovered.status, 'noop');
    assert.equal(
      recovered.sources.some(
        (source) => source.sourceKind === 'canonical' && source.sha256 === mod.hashContent('CANONICAL BEFORE'),
      ),
      true,
      'recovery must preserve the original canonical source in the durable journal',
    );
    assert.equal(existsSync(join(sourceRoot, '.migrated-to-cat-cafe-data-dir.json')), true);
    assert.equal(existsSync(join(runtimeRoot, '.migrated-to-cat-cafe-data-dir.json')), true);
  });

  it('rejects a stale resolution when any source hash changed', () => {
    const oldPath = join(sourceRoot, 'relationship', 'codex-primer.md');
    const approvedPath = join(runtimeRoot, 'relationship', 'codex-sol-primer.md');
    writeFileSync(oldPath, 'OLD');
    writeFileSync(approvedPath, 'APPROVED');
    const mergedPath = join(tmp, 'merged.md');
    writeFileSync(mergedPath, 'MERGED');
    const resolutionFile = join(tmp, 'resolution.json');
    writeFileSync(
      resolutionFile,
      JSON.stringify({
        version: 1,
        resolutions: {
          'relationship/maine-coon-primer.md': {
            contentFile: mergedPath,
            expectedSourceHashes: [mod.hashContent('OLD'), mod.hashContent('APPROVED')].sort(),
          },
        },
      }),
    );
    writeFileSync(approvedPath, 'CHANGED AFTER REVIEW');

    assert.throws(
      () => mod.runProfileMigration(options({ apply: true, resolutionFile })),
      /source hashes do not match/i,
    );
    assert.equal(existsSync(join(dataDir, 'profiles', 'you')), false);
  });

  it('repeated apply is a byte-identical no-op', () => {
    writeFileSync(join(sourceRoot, 'relationship', 'opus-primer.md'), 'ONE PERSONA');
    const first = mod.runProfileMigration(options({ apply: true }));
    const canonical = join(dataDir, 'profiles', 'you', 'relationship', 'ragdoll-primer.md');
    const firstBytes = readFileSync(canonical);

    const second = mod.runProfileMigration(options({ apply: true }));

    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'noop');
    assert.deepEqual(readFileSync(canonical), firstBytes);
    assert.equal(second.backupDir, first.backupDir);
  });

  it('rollback restores pre-existing canonical bytes and refuses to overwrite later edits', () => {
    writeFileSync(join(sourceRoot, 'relationship', 'opus-primer.md'), 'MIGRATED');
    const canonical = join(dataDir, 'profiles', 'you', 'relationship', 'ragdoll-primer.md');
    mkdirSync(join(dataDir, 'profiles', 'you', 'relationship'), { recursive: true });
    writeFileSync(canonical, 'BEFORE');
    const mergedPath = join(tmp, 'merged.md');
    writeFileSync(mergedPath, 'MERGED');
    const resolutionFile = join(tmp, 'resolution.json');
    writeFileSync(
      resolutionFile,
      JSON.stringify({
        version: 1,
        resolutions: {
          'relationship/ragdoll-primer.md': {
            contentFile: mergedPath,
            expectedSourceHashes: [mod.hashContent('BEFORE'), mod.hashContent('MIGRATED')].sort(),
          },
        },
      }),
    );
    const applied = mod.runProfileMigration(options({ apply: true, resolutionFile }));
    writeFileSync(canonical, 'USER EDIT AFTER MIGRATION');

    assert.throws(() => mod.rollbackProfileMigration(applied.backupDir), /canonical content changed after migration/i);
    writeFileSync(canonical, 'MERGED');
    const rolledBack = mod.rollbackProfileMigration(applied.backupDir);

    assert.equal(rolledBack.status, 'rolled-back');
    assert.equal(readFileSync(canonical, 'utf8'), 'BEFORE');
    assert.equal(existsSync(join(sourceRoot, '.migrated-to-cat-cafe-data-dir.json')), false);
  });
});
