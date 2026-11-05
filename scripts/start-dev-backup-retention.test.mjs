import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyBackupRetention, planBackupRetention } from './redis-backup-retention.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(scripts, 'start-dev.sh'), 'utf8');
const prune = source.match(/^prune_redis_backups\(\) \{\n[\s\S]*?^\}/m)[0];
const archive = source.match(/^archive_redis_snapshot\(\) \{\n[\s\S]*?^\}/m)[0];
// Minimal structural fixture, not a claim of a checksum-valid Redis database.
const snapshot = (content = '') =>
  Buffer.concat([Buffer.from(`REDIS0011${content}`), Buffer.from([255]), Buffer.alloc(8)]);

test('restart bursts retain three recent snapshots plus daily recovery points, never manual backups', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-backup-retention-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const names = [];
  const add = (name, age) => {
    const path = join(root, name);
    writeFileSync(path, snapshot());
    utimesSync(path, new Date(now - age), new Date(now - age));
    names.push(name);
  };
  for (let i = 0; i < 20; i++) add(`fixture-pre-start-20261015-${String(i).padStart(6, '0')}.rdb`, i * 1000);
  add('fixture-pre-start-20261010-000000.rdb', 5 * 86400000);
  add('fixture-manual-20260901-000000.rdb', 40 * 86400000);
  add('other-pre-start-20261010-000000.rdb', 5 * 86400000);
  const result = spawnSync('/bin/bash', ['-eu'], {
    input: `${prune}\nprune_redis_backups 20\n`,
    encoding: 'utf8',
    env: { ...process.env, SCRIPT_DIR: scripts, REDIS_BACKUP_DIR: root, REDIS_STORAGE_KEY: 'fixture' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(names.filter((name) => name.includes('-pre-start-20261015-') && existsSync(join(root, name))).length, 3);
  assert.ok(existsSync(join(root, 'fixture-pre-start-20261010-000000.rdb')));
  assert.ok(existsSync(join(root, 'fixture-manual-20260901-000000.rdb')));
  assert.ok(existsSync(join(root, 'other-pre-start-20261010-000000.rdb')));
});

test('dry run preserves every file and the oldest anchor outlives the daily window', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-backup-plan-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 9, 15, 12);
  for (let day = 0; day < 14; day++) {
    const path = join(root, `dev-pre-start-202610${String(day + 1).padStart(2, '0')}-000000.rdb`);
    writeFileSync(path, snapshot(`snapshot ${day}`));
    utimesSync(path, (now - day * 86400000) / 1000, (now - day * 86400000) / 1000);
  }
  const plan = planBackupRetention(root, 'dev', now);
  assert.equal(plan.keep.length, 8);
  assert.ok(plan.keep.some((entry) => entry.name === 'dev-pre-start-20261014-000000.rdb'));
  for (const entry of [...plan.keep, ...plan.remove]) assert.ok(existsSync(join(root, entry.name)));
  applyBackupRetention(root, 'dev', now);
  for (const entry of plan.keep) assert.ok(existsSync(join(root, entry.name)));
  for (const entry of plan.remove) assert.equal(existsSync(join(root, entry.name)), false);
});

test('a symlink candidate refuses all pruning, including otherwise eligible files', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-backup-refusal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = join(root, 'manual.rdb');
  writeFileSync(original, 'must remain');
  symlinkSync(original, join(root, 'dev-pre-start-20261015-000000.rdb'));
  assert.throws(() => applyBackupRetention(root, 'dev'), /independent file/);
  assert.equal(readFileSync(original, 'utf8'), 'must remain');
  assert.throws(() => planBackupRetention(root, '../dev'), /storage key/);
});

test('truncated and empty snapshots never displace a good daily point or block pruning', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-backup-incomplete-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 9, 15, 23);
  const add = (name, hour, bytes = snapshot()) => {
    const path = join(root, `dev-pre-start-${name}.rdb`);
    writeFileSync(path, bytes);
    utimesSync(path, hour / 1000, hour / 1000);
    return path;
  };
  for (let i = 0; i < 3; i++) add(`20261015-00000${i}`, now - i * 3600000);
  add('20261001-000000', now - 14 * 86400000);
  const good = add('20261013-080000', Date.UTC(2026, 9, 13, 8));
  const broken = add('20261013-230000', Date.UTC(2026, 9, 13, 23), Buffer.from('REDIS0011incomplete copy'));
  const empty = add('20261014-230000', Date.UTC(2026, 9, 14, 23), Buffer.alloc(0));
  const redundant = add('20261013-070000', Date.UTC(2026, 9, 13, 7));
  const plan = planBackupRetention(root, 'dev', now);
  assert.ok(plan.keep.some((item) => join(root, item.name) === good));
  assert.equal(plan.invalid.length, 2);
  applyBackupRetention(root, 'dev', now);
  for (const path of [good, broken, empty]) assert.ok(existsSync(path));
  assert.equal(existsSync(redundant), false);
});

test('a failed snapshot copy leaves no published RDB or partial and never prunes', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-backup-copy-failure-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backups = join(root, 'backups');
  mkdirSync(backups);
  writeFileSync(join(root, 'dump.rdb'), snapshot());
  const result = spawnSync('/bin/bash', ['-eu'], {
    input:
      `${archive}\nensure_redis_dirs() { :; }\nredis_ping() { return 1; }\n` +
      'prune_redis_backups() { echo UNEXPECTED_PRUNE; }\n' +
      'cp() { local destination; for destination in "$@"; do :; done; printf REDIS0011partial > "$destination"; return 1; }\n' +
      'archive_redis_snapshot pre-start\n',
    encoding: 'utf8',
    env: {
      ...process.env,
      REDIS_BACKUP_DIR: backups,
      REDIS_STORAGE_KEY: 'dev',
      REDIS_DATA_DIR: root,
      REDIS_DBFILE: 'dump.rdb',
      SCRIPT_DIR: scripts,
      GREEN: '',
      YELLOW: '',
      NC: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_PRUNE/);
  assert.deepEqual(readdirSync(backups), []);
});

for (const complete of [true, false]) {
  test(`snapshot publication ${complete ? 'renames a complete private copy before pruning' : 'refuses a successful copy of truncated input'}`, (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-backup-publication-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const backups = join(root, 'backups');
    mkdirSync(backups);
    writeFileSync(join(root, 'dump.rdb'), complete ? snapshot('original bytes') : Buffer.from('REDIS0011truncated'));
    const trace = join(root, 'copied-path');
    const result = spawnSync('/bin/bash', ['-eu'], {
      input:
        `${archive}\nensure_redis_dirs() { :; }\nredis_ping() { return 1; }\n` +
        'prune_redis_backups() { echo PRUNED; }\n' +
        'cp() { local destination; for destination in "$@"; do :; done; printf "%s" "$destination" > "$COPY_TRACE"; /bin/cp "$@"; }\n' +
        'archive_redis_snapshot pre-start\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        REDIS_BACKUP_DIR: backups,
        REDIS_STORAGE_KEY: 'dev',
        REDIS_DATA_DIR: root,
        REDIS_DBFILE: 'dump.rdb',
        SCRIPT_DIR: scripts,
        GREEN: '',
        YELLOW: '',
        NC: '',
        COPY_TRACE: trace,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(trace, 'utf8'), /\.rdb\.partial\./);
    assert.equal(readdirSync(backups).length, complete ? 1 : 0);
    if (complete) {
      assert.match(result.stdout, /PRUNED/);
      assert.equal(readdirSync(backups)[0].endsWith('.rdb'), true);
      assert.deepEqual(readFileSync(join(backups, readdirSync(backups)[0])), readFileSync(join(root, 'dump.rdb')));
    } else assert.doesNotMatch(result.stdout, /PRUNED/);
  });
}

test('equal source mtimes select the newest snapshot names and the oldest named anchor', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-backup-tied-time-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 9, 15, 12);
  for (let i = 1; i <= 5; i++) {
    const path = join(root, `dev-pre-start-20261015-00000${i}.rdb`);
    writeFileSync(path, snapshot());
    utimesSync(path, now / 1000, now / 1000);
  }
  const plan = planBackupRetention(root, 'dev', now);
  assert.deepEqual(
    plan.keep.map((item) => item.name.slice(-5, -4)),
    ['5', '4', '3', '1'],
  );
});

test('old partial snapshots are reported for inspection without deletion or recovery slots', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-backup-old-partial-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now() + 3 * 3600000;
  const old = join(root, 'dev-pre-start-20261015-080000.rdb.partial.ABC123');
  const recent = join(root, 'dev-pre-start-20261015-115900.rdb.partial.DEF456');
  for (const path of [old, recent]) writeFileSync(path, snapshot());
  utimesSync(old, (now - 7200000) / 1000, (now - 7200000) / 1000);
  utimesSync(recent, (now - 60000) / 1000, (now - 60000) / 1000);
  const plan = applyBackupRetention(root, 'dev', now);
  assert.equal(plan.partials?.length, 1);
  assert.equal(join(root, plan.partials[0].name), old);
  assert.equal(plan.keep.length + plan.remove.length, 0);
  for (const path of [old, recent]) assert.ok(existsSync(path));
});
