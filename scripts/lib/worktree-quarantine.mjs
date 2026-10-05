/**
 * Quarantine for the worktree reaper: the automatic action moves a directory aside instead of
 * deleting it, so anything no probe could see (hidden index state, custom refs, ignored files…)
 * stays restorable for `quarantineDays`. `purge` is the only code path that deletes, and it refuses
 * anything outside the quarantine root.
 *
 * Layout: <parent>/.reaper-quarantine/<YYYYMMDDTHHMMSSmmmZ>-<txn8>/<name>, plus a write-ahead ledger.jsonl
 * with a restore command for every move; purge trusts only a destination's latest, transaction-matched
 * `done` record, stamped after the move finished. Registered worktrees move with `git worktree move`, so
 * they stay in `git worktree list` and can be moved back; standalone clones move with rename (same volume).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { git } from './worktree-reaper-probes.mjs';

export const QUARANTINE_DIRNAME = '.reaper-quarantine';

export function quarantineRoot(parent) {
  return join(parent, QUARANTINE_DIRNAME);
}

/**
 * Directory-name stamp (e.g. 20260918T031500123Z) that keeps destinations unique. It is layout only:
 * a directory can be renamed, so the restore window is never read from it (review round 5).
 */
export function quarantineStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

function ledgerFile(root) {
  return join(root, 'ledger.jsonl');
}

function appendLedger(root, record, now) {
  mkdirSync(root, { recursive: true });
  appendFileSync(ledgerFile(root), `${JSON.stringify({ at: new Date(now).toISOString(), ...record })}\n`);
}

/**
 * The only source of truth for "when was this quarantined". The ledger is folded per destination path in
 * log order, and the LATEST record for a destination decides its state:
 * - `pending` opens a transaction (txn id); a later `done` counts only if it carries that same txn;
 * - any newer `pending`/`aborted` for the destination supersedes an older `done` (review round 6);
 * - a `done` with no matching open pending (forged, corrupted, reordered) authorises nothing.
 * Returns destination → epoch ms of its completed move, only for destinations whose latest state is a
 * matched `done`. Unparseable lines are skipped, which can only shrink the purgeable set.
 */
export function readQuarantineRecords(root) {
  let text = '';
  try {
    text = readFileSync(ledgerFile(root), 'utf8');
  } catch {
    return new Map();
  }
  /** @type {Map<string, {txn: string, doneAt: number|null}|null>} */
  const state = new Map();
  for (const line of text.split('\n')) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.action !== 'quarantine' || typeof rec.to !== 'string') continue;
    const at = Date.parse(rec.at ?? '');
    const open = state.get(rec.to);
    if (rec.state === 'pending' && typeof rec.txn === 'string' && rec.txn !== '') {
      state.set(rec.to, { txn: rec.txn, doneAt: null });
    } else if (rec.state === 'done' && open && open.doneAt === null && open.txn === rec.txn && Number.isFinite(at)) {
      state.set(rec.to, { txn: open.txn, doneAt: at });
    } else {
      state.set(rec.to, null); // aborted, unmatched done, or malformed: nothing authorised for this destination
    }
  }
  const done = new Map();
  for (const [to, s] of state) if (s?.doneAt != null) done.set(to, s.doneAt);
  return done;
}

/**
 * `<stamp>-<txn8>/<name>`: the transaction id is part of the path, so a destination is never reused and no
 * historical ledger record can ever match a later move (review round 6). Refuses rather than overwrites.
 */
function freshDestination(root, name, startedAt, txn) {
  const dest = join(root, `${quarantineStamp(startedAt)}-${txn.slice(0, 8)}`, name);
  if (existsSync(dest)) throw new Error(`quarantine destination already exists: ${dest}`);
  return dest;
}

/**
 * Move one entry into quarantine, write-ahead: `pending` (with the restore command) is recorded BEFORE the
 * move, so a failed ledger write moves nothing; `done` after it succeeds; `aborted` if the move failed.
 * If the `done` write itself fails, the entry keeps its pending record (restore command included) and is
 * never purged, because purge only trusts done records. Returns the destination; throws on any failure.
 */
export function moveToQuarantine({ repo, root, entry, clock = Date.now }) {
  const txn = randomUUID();
  const startedAt = clock();
  const dest = freshDestination(root, entry.name, startedAt, txn);
  const restore = entry.registered
    ? `git -C ${JSON.stringify(repo)} worktree move ${JSON.stringify(dest)} ${JSON.stringify(entry.path)}`
    : `mv ${JSON.stringify(dest)} ${JSON.stringify(entry.path)}`;
  const base = {
    action: 'quarantine',
    txn,
    from: entry.path,
    to: dest,
    kind: entry.kind,
    reason: entry.reason,
    restore,
  };
  appendLedger(root, { ...base, state: 'pending' }, startedAt);
  try {
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.registered) {
      const res = git(repo, ['worktree', 'move', entry.path, dest]); // no --force: locked/odd states refuse
      if (!res.ok) throw new Error('git worktree move refused');
    } else {
      renameSync(entry.path, dest);
    }
  } catch (err) {
    try {
      appendLedger(root, { ...base, state: 'aborted', error: err.message }, clock());
    } catch {}
    throw err;
  }
  // Sampled AFTER the move succeeded: the restore window starts when the directory is actually in quarantine,
  // not when the batch started (review round 7).
  appendLedger(root, { ...base, state: 'done' }, clock());
  return dest;
}

/** Permanently delete one quarantined entry. The only deleting path; confined to the quarantine root. */
export function purgeQuarantined({ repo, root, entry }) {
  const rel = relative(root, entry.path);
  if (rel === '' || rel.startsWith('..') || rel.split('/').length < 2) {
    throw new Error(`refusing to purge outside quarantine: ${entry.path}`);
  }
  if (entry.registered) {
    const res = git(repo, ['worktree', 'remove', '--force', entry.path]);
    if (!res.ok) throw new Error('git worktree remove --force refused');
  } else {
    rmSync(entry.path, { recursive: true, force: true });
  }
  appendLedger(root, { action: 'purge', path: entry.path, kind: entry.kind }, Date.now());
  try {
    rmdirSync(dirname(entry.path)); // drop the day directory once empty
  } catch {}
}
