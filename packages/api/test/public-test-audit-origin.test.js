import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publicTestExclusionMatchHash, resolvePublicTestFiles } from '../scripts/resolve-public-test-files.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'public-audit-origin-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'packages/api');
  mkdirSync(join(packageRoot, 'test'), { recursive: true });
  const sourceFile = 'test/redis-source.test.js';
  const targetFile = 'test/redis-community.test.js';
  writeFileSync(join(packageRoot, sourceFile), '');
  const audit = (files) => ({
    reviewedOn: '2026-10-21',
    sourceHead: 'a'.repeat(40),
    publicHead: 'b'.repeat(40),
    status: 'resource_contract',
    matchedFileCount: files.length,
    matchedFilesHash: publicTestExclusionMatchHash(files),
  });
  mkdirSync(join(packageRoot, 'config'), { recursive: true });
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  const cli = join(packageRoot, 'scripts/resolve-public-test-files.mjs');
  cpSync(fileURLToPath(new URL('../scripts/resolve-public-test-files.mjs', import.meta.url)), cli);
  const configPath = join(packageRoot, 'config/public-test-exclusions.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 2,
      entries: [
        {
          id: 'redis',
          match: '^test/redis-.*\\.test\\.js$',
          category: 'resource_contract',
          reason: 'Synthetic source inventory plus one target-owned community test.',
          owner: '@fixture',
          introducedBy: 'fixture',
          expiresOn: '2030-01-01',
          audit: audit([sourceFile]),
          publicAudit: audit([sourceFile, targetFile]),
        },
      ],
    }),
  );
  return {
    root,
    cli,
    packageRoot,
    sourceFile,
    targetFile,
    run: () => resolvePublicTestFiles({ packageRoot, configPath, today: '2026-10-21' }),
    provenance: (data) => writeFileSync(join(root, '.sync-provenance.json'), JSON.stringify(data)),
  };
}

test('a source-managed export with no target uses the exact source audit', async (t) => {
  const f = fixture(t);
  f.provenance({ source_commit_sha: 'a'.repeat(40), target_head_sha: '' });
  assert.deepEqual((await f.run()).excludedFiles, [f.sourceFile]);
});

test('native CLI selects the source-managed export without an override flag', (t) => {
  const f = fixture(t);
  f.provenance({ source_commit_sha: 'a'.repeat(40), target_head_sha: '' });
  const result = spawnSync(process.execPath, [f.cli, '--json'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).excludedFiles, [f.sourceFile]);
});

test('native CLI executes through a source root path alias rather than silently returning success', (t) => {
  const f = fixture(t);
  f.provenance({ source_commit_sha: 'a'.repeat(40), target_head_sha: '' });
  const alias = join(f.root, 'alias');
  symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(
    process.execPath,
    [join(alias, 'packages/api/scripts/resolve-public-test-files.mjs'), '--json'],
    {
      cwd: f.root,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), '', 'a logical path must execute the selector');
  assert.deepEqual(JSON.parse(result.stdout).excludedFiles, [f.sourceFile]);
});

test('a preserved target uses its public audit and cannot lose the community suite', async (t) => {
  const f = fixture(t);
  f.provenance({ source_commit_sha: 'a'.repeat(40), target_head_sha: 'b'.repeat(40) });
  writeFileSync(join(f.packageRoot, f.targetFile), '');
  assert.deepEqual((await f.run()).excludedFiles, [f.targetFile, f.sourceFile].sort());
  unlinkSync(join(f.packageRoot, f.targetFile));
  await assert.rejects(f.run(), /audited match inventory drift/);
});

test('source audit does not automatically trust extra files or unpinned provenance', async (t) => {
  const f = fixture(t);
  f.provenance({ source_commit_sha: 'a'.repeat(40), target_head_sha: '' });
  writeFileSync(join(f.packageRoot, f.targetFile), '');
  await assert.rejects(f.run(), /audited match inventory drift/);
  unlinkSync(join(f.packageRoot, f.targetFile));
  f.provenance({ target_head_sha: '' });
  await assert.rejects(f.run(), /source-managed export requires a pinned source commit/);
});

test('legacy provenance without a target field retains the public audit', async (t) => {
  const f = fixture(t);
  f.provenance({ source_commit_sha: 'a'.repeat(40) });
  writeFileSync(join(f.packageRoot, f.targetFile), '');
  assert.deepEqual((await f.run()).excludedFiles, [f.targetFile, f.sourceFile].sort());
});

test('malformed provenance fails instead of selecting an inventory by its contents', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.packageRoot, f.targetFile), '');
  writeFileSync(join(f.root, '.sync-provenance.json'), '{');
  await assert.rejects(f.run(), SyntaxError);
});
