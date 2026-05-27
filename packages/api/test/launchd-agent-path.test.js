import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(process.cwd(), '../..');

for (const script of ['scripts/user-redis-autobackup.sh', 'scripts/thread-exports-autosave.sh']) {
  test(`${script} bootstraps launchd-safe PATH for Homebrew tools`, () => {
    const source = readFileSync(resolve(repoRoot, script), 'utf8');

    assert.match(source, /LAUNCHD_SAFE_PATH=.*\/opt\/homebrew\/bin/);
    assert.match(source, /export PATH="\$\{LAUNCHD_SAFE_PATH\}:\$\{PATH:-\}"/);
    assert.match(source, /<key>PATH<\/key>[\s\S]*<string>\$\{LAUNCHD_SAFE_PATH\}<\/string>/);
  });
}

test('thread export autosave uses ignored local backup output under launchd', () => {
  const source = readFileSync(resolve(repoRoot, 'scripts/thread-exports-autosave.sh'), 'utf8');
  const exportSource = readFileSync(resolve(repoRoot, 'scripts/export-threads-from-redis.mjs'), 'utf8');
  const syncSource = readFileSync(resolve(repoRoot, 'scripts/thread-exports-sync.sh'), 'utf8');
  const gitignore = readFileSync(resolve(repoRoot, '.gitignore'), 'utf8');

  assert.match(source, /PROJECT_DIR=.*SCRIPT_DIR\/\.\./);
  assert.match(source, /EXPORT_OUT_DIR=.*\.cat-cafe\/thread-exports\/repo/);
  assert.match(source, /<key>WorkingDirectory<\/key>[\s\S]*<string>\$\{PROJECT_DIR\}<\/string>/);
  assert.match(source, /<key>THREAD_EXPORT_REPO_DIR<\/key>[\s\S]*<string>\$\{EXPORT_OUT_DIR\}<\/string>/);
  assert.match(source, /--out-dir "\$EXPORT_OUT_DIR"/);
  assert.match(source, /THREAD_EXPORT_REPO_DIR="\$EXPORT_OUT_DIR" "\$SYNC_SCRIPT" sync/);
  assert.match(exportSource, /--out-dir\s+\.cat-cafe\/thread-exports\/repo/);
  assert.match(exportSource, /outDir: path\.resolve\(process\.cwd\(\), '\.cat-cafe\/thread-exports\/repo'\)/);
  assert.match(syncSource, /REPO_DIR=.*\.cat-cafe\/thread-exports\/repo/);
  assert.match(gitignore, /^docs\/discussions\/exported-threads\/$/m);
  assert.doesNotMatch(source, /docs\/discussions\/exported-threads/);
});

test('redis autobackup keeps local backups when offsite copy is denied', () => {
  const source = readFileSync(resolve(repoRoot, 'scripts/user-redis-autobackup.sh'), 'utf8');

  assert.match(source, /OFFSITE_STRICT=/);
  assert.match(source, /copy_offsite_backup\(\)/);
  assert.match(source, /offsite_warn_or_fail/);
  assert.match(source, /latest_tmp=.*\$\$/);
  assert.match(source, /mv -f "\$latest_tmp" "\$latest_target"/);
  assert.match(source, /warning: \$message/);
  assert.match(source, /USER_REDIS_OFFSITE_STRICT/);
});

test('thread export sync keeps repo exports when offsite copy is denied', () => {
  const source = readFileSync(resolve(repoRoot, 'scripts/thread-exports-sync.sh'), 'utf8');

  assert.match(source, /THREAD_EXPORT_OFFSITE_STRICT/);
  assert.match(source, /thread_export_offsite_warn_or_fail/);
  assert.match(source, /copy_offsite_file\(\)/);
  assert.match(source, /latest_tmp=.*\$\$/);
  assert.match(source, /mv -f "\$latest_tmp" "\$latest_target"/);
  assert.match(source, /offsite latest:skipped/);
});
