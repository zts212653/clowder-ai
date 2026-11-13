import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 64 * 1024;
const MAX_EVENTS = 256;
const REGIONS = new Set([
  'index/do_read_index',
  'index/preload',
  'index/refresh',
  'index/do_write_index',
  'cache_tree/read',
  'cache_tree/write',
  'status/worktrees',
  'status/index',
  'status/untracked',
  'status/print',
  'diff/setup',
  'diff/write back to queue',
  'unpack_trees/unpack_trees',
]);
const COUNTERS = new Set([
  'index/read/cache_nr',
  'index/preload/sum_lstat',
  'index/refresh/sum_lstat',
  'index/refresh/sum_scan',
  'index/write/cache_nr',
  'status/count/changed',
  'status/count/untracked',
  'status/count/ignored',
]);

function recordRegion(event, active, completed) {
  const region = `${event.category}/${event.label}`;
  if (!REGIONS.has(region)) return;
  // Session/thread labels are only used for matching, never published.
  const key = `${event.sid}:${event.thread}:${region}`;
  if (event.event === 'region_enter') active.set(key, region);
  if (event.event !== 'region_leave') return;
  active.delete(key);
  const seconds = event.t_rel;
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400)
    completed.push({ region, durationMs: Math.round(seconds * 1_000_000) / 1_000 });
}

function recordCounter(event, counters) {
  const key = `${event.category}/${event.key}`;
  if (event.event !== 'data' || !COUNTERS.has(key) || !/^\d{1,16}$/u.test(String(event.value))) return;
  const value = Number(event.value);
  if (Number.isSafeInteger(value)) counters[key] = value;
}

/** Only fixed phase names and numeric counters can leave the private trace. */
function summarize(buffer, truncated) {
  const lines = buffer.toString('utf8').split('\n');
  if (truncated) lines.shift();
  const tail = lines.filter(Boolean).slice(-MAX_EVENTS);
  const active = new Map();
  const completed = [];
  const counters = {};
  let parsed = 0;
  for (const line of tail) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    parsed++;
    recordRegion(event, active, completed);
    recordCounter(event, counters);
  }
  return {
    status: parsed ? 'captured' : 'unavailable',
    truncated: truncated || lines.filter(Boolean).length > MAX_EVENTS,
    activeRegions: [...new Set(active.values())].slice(-8),
    completedRegions: completed.slice(-12),
    counters,
  };
}

/** Git accepts Trace2 on inherited fd3. Unlink before spawn so crashes leave no raw trace path. */
export function createAlphaGitTrace() {
  let directory;
  let fd;
  try {
    directory = mkdtempSync(join(tmpdir(), 'cat-cafe-alpha-git-'));
    const file = join(directory, 'trace');
    fd = openSync(file, 'wx+', 0o600);
    unlinkSync(file);
    rmdirSync(directory);
  } catch {
    // Diagnostics cannot turn a valid checkout into an admission failure.
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      /* already unavailable */
    }
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch {
      /* empty private file only */
    }
    return null;
  }
  return {
    environment: { ...process.env, GIT_TRACE2_EVENT: '3' },
    stdio: ['ignore', 'pipe', 'pipe', fd],
    read() {
      try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, MAX_BYTES);
        const buffer = Buffer.alloc(length);
        const bytes = readSync(fd, buffer, 0, length, Math.max(0, size - length));
        return summarize(buffer.subarray(0, bytes), size > length);
      } catch {
        return { status: 'unavailable' };
      }
    },
    close() {
      closeSync(fd);
    },
  };
}
