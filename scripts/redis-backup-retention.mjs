#!/usr/bin/env node
/** Thin restart bursts without discarding manual backups or the oldest recovery anchor. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;
const identity = (st) => [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');

// Detect incomplete copies cheaply; full checksum validation remains an offline recovery check.
export function hasRdbEnvelope(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 18) return false;
    const header = Buffer.alloc(9);
    const eof = Buffer.alloc(1);
    const complete =
      readSync(fd, header, 0, 9, 0) === 9 &&
      /^REDIS[0-9]{4}$/.test(header.toString('latin1')) &&
      readSync(fd, eof, 0, 1, before.size - 9) === 1 &&
      eof[0] === 0xff;
    if (identity(fstatSync(fd)) !== identity(before)) throw new Error('snapshot changed while reading its envelope');
    return complete;
  } finally {
    closeSync(fd);
  }
}

export function planBackupRetention(directory, prefix, now = Date.now()) {
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('invalid backup storage key');
  const root = resolve(directory);
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(root) !== root)
    throw new Error('backup directory must be a real directory without symlink ancestors');
  if (process.getuid && st.uid !== process.getuid()) throw new Error('backup directory has another owner');
  const pattern = new RegExp(`^${prefix}-(?:pre-start|pre-stop)-[0-9]{8}-[0-9]{6}\\.rdb$`);
  const partialPattern = new RegExp(
    `^${prefix}-(?:pre-start|pre-stop|manual)-[0-9]{8}-[0-9]{6}\\.rdb\\.partial\\.[a-zA-Z0-9]+$`,
  );
  const names = readdirSync(root);
  const partials = names
    .filter((name) => partialPattern.test(name))
    .map((name) => {
      const file = lstatSync(join(root, name));
      return {
        name,
        bytes: file.size,
        ageMs: Math.max(0, now - Math.max(file.mtimeMs, file.ctimeMs)),
        reason: 'old partial; inspect receipt and active writers before any manual cleanup',
      };
    })
    .filter((item) => item.ageMs >= 3_600_000);
  const invalid = [];
  const snapshots = names
    .filter((name) => pattern.test(name))
    .map((name) => {
      const file = lstatSync(join(root, name));
      if (!file.isFile() || file.nlink !== 1 || file.uid !== st.uid)
        throw new Error(`backup is not an owned independent file: ${name}`);
      return { name, bytes: file.size, modifiedAt: file.mtimeMs, identity: identity(file) };
    })
    .filter((item) => {
      if (hasRdbEnvelope(join(root, item.name))) return true;
      invalid.push({
        ...item,
        reason: 'missing Redis header or EOF/checksum envelope; retained without a recovery slot',
      });
      return false;
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
  const keep = new Set(snapshots.slice(0, 3).map((item) => item.name));
  if (snapshots.length) keep.add(snapshots.at(-1).name);
  const days = new Set();
  const today = Math.floor(now / DAY);
  for (const item of snapshots) {
    const day = Math.floor(item.modifiedAt / DAY);
    // Unexpected future timestamps are retained, never used to evict known recovery points.
    if (day > today) keep.add(item.name);
    if (day <= today && day > today - 7 && !days.has(day)) {
      keep.add(item.name);
      days.add(day);
    }
  }
  return {
    directory: root,
    prefix,
    policy: { recent: 3, dailyDays: 7, oldestAnchor: true, manual: 'always retain' },
    keep: snapshots.filter((item) => keep.has(item.name)),
    remove: snapshots.filter((item) => !keep.has(item.name)),
    invalid,
    partials,
  };
}

export function applyBackupRetention(directory, prefix, now = Date.now()) {
  const initial = planBackupRetention(directory, prefix, now);
  const lock = join(initial.directory, '.backup-retention.lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    const plan = planBackupRetention(directory, prefix, now);
    // Check the whole frozen inventory before the first removal.
    for (const item of [...plan.keep, ...plan.remove]) {
      if (identity(lstatSync(join(plan.directory, item.name))) !== item.identity)
        throw new Error('backup changed during retention planning');
    }
    for (const item of plan.remove) {
      // A new restart or external writer cannot silently replace a deletion candidate.
      const path = join(plan.directory, item.name);
      if (identity(lstatSync(path)) !== item.identity) throw new Error('backup changed before removal');
      unlinkSync(path);
    }
    return plan;
  } finally {
    rmdirSync(lock);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, prefix, action] = process.argv.slice(2);
  try {
    if (directory === '--check-snapshot') {
      if (!prefix || action !== undefined || !hasRdbEnvelope(prefix))
        throw new Error('incomplete Redis snapshot envelope');
    } else {
      if (!directory || !prefix || (action !== undefined && action !== '--apply'))
        throw new Error('usage: redis-backup-retention.mjs <directory> <storage-key> [--apply]');
      const plan =
        action === '--apply' ? applyBackupRetention(directory, prefix) : planBackupRetention(directory, prefix);
      console.log(JSON.stringify({ ...plan, applied: action === '--apply' }));
      if (plan.invalid.length)
        console.error(`[backup-retention] ${plan.invalid.length} incomplete snapshots retained outside recovery slots`);
      if (plan.partials.length)
        console.error(
          `[backup-retention] ${plan.partials.length} partial snapshots unchanged for an hour; inspect writers and receipts`,
        );
    }
  } catch (error) {
    console.error(`[backup-retention] ${error.message}`);
    process.exitCode = 1;
  }
}
