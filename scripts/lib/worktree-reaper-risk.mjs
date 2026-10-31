/**
 * Report-only risk notes for the reaper ledger.
 *
 * These probes are NOT part of any deletion proof (design review: "this directory holds no
 * user state" is an open enumeration). Quarantine keeps everything restorable, so these columns exist
 * to tell a human what a quarantined or reviewed directory still carries before the purge window ends.
 * Each returns a count, or null when it could not be determined.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, isHollowTree, isSkillLinkTree } from './worktree-reaper-probes.mjs';

/** Ignored entries other than skill links (`git status` never shows them). */
export function ignoredContent(dir) {
  const res = git(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  if (!res.ok) return null;
  return res.out
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !isSkillLinkTree(dir, join(dir, rel.replace(/\/$/, '')))).length;
}

/** assume-unchanged / skip-worktree entries and sparse checkout: edits `git status` hides. */
export function hiddenIndexState(dir) {
  const res = git(dir, ['ls-files', '-v', '-z']);
  if (!res.ok) return null;
  let n = res.out
    .split('\0')
    .filter(Boolean)
    .filter((rec) => /^[a-z]/.test(rec) || rec.startsWith('S ')).length;
  const sparse = git(dir, ['config', '--bool', 'core.sparseCheckout']);
  if (sparse.ok && sparse.out.trim() === 'true') n++;
  else if (!sparse.ok && sparse.code !== 1) return null;
  return n;
}

const KNOWN_GITDIR = new Set([
  'HEAD',
  'ORIG_HEAD',
  'index',
  'commondir',
  'gitdir',
  'FETCH_HEAD',
  'logs',
  'refs',
  'COMMIT_EDITMSG',
  'config.worktree',
]);

function normalizeMessage(s) {
  return s
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/** Per-worktree git state beyond the usual set: in-progress ops, worktree refs, unsent commit draft. */
export function worktreeGitState(dir) {
  const gd = git(dir, ['rev-parse', '--absolute-git-dir']);
  if (!gd.ok) return null;
  const gitdir = gd.out.trim();
  try {
    let n = readdirSync(gitdir).filter((name) => !KNOWN_GITDIR.has(name)).length;
    const logs = join(gitdir, 'logs');
    if (lstatSync(logs, { throwIfNoEntry: false })) n += readdirSync(logs).filter((x) => x !== 'HEAD').length;
    const refs = join(gitdir, 'refs');
    if (lstatSync(refs, { throwIfNoEntry: false }) && !isHollowTree(refs)) n++;
    const msgFile = join(gitdir, 'COMMIT_EDITMSG');
    if (lstatSync(msgFile, { throwIfNoEntry: false })) {
      const draft = normalizeMessage(readFileSync(msgFile, 'utf8'));
      const msgs = git(dir, ['log', '-g', '--format=%B%x00', 'HEAD']);
      const known = msgs.ok ? new Set(msgs.out.split('\0').map(normalizeMessage)) : new Set();
      if (draft !== '' && !known.has(draft)) n++;
    }
    return n;
  } catch {
    return null;
  }
}

/** Commits only this worktree's HEAD reflog / ORIG_HEAD reach (no remote, branch or tag does). */
export function reflogOnlyCommits(dir) {
  const log = git(dir, ['log', '-g', '--format=%H', 'HEAD']);
  if (!log.ok && !(log.out === '' && log.code === 128)) return null;
  const orig = git(dir, ['rev-parse', '--verify', '--quiet', 'ORIG_HEAD']);
  const shas = [...new Set([...log.out.split('\n'), orig.ok ? orig.out.trim() : ''].filter(Boolean))];
  let total = 0;
  for (let i = 0; i < shas.length; i += 200) {
    const res = git(dir, [
      'rev-list',
      '--count',
      ...shas.slice(i, i + 200),
      '--not',
      '--remotes',
      '--branches',
      '--tags',
    ]);
    const n = res.ok ? Number.parseInt(res.out.trim(), 10) : Number.NaN;
    if (!Number.isFinite(n)) return null;
    total += n;
  }
  return total;
}

/** All risk notes as `name=count` (or `name=?`), only the non-zero ones, for the ledger. */
export function riskNotes(dir) {
  const notes = {
    ignored: ignoredContent(dir),
    hiddenIndex: hiddenIndexState(dir),
    gitState: worktreeGitState(dir),
    reflogOnly: reflogOnlyCommits(dir),
  };
  return Object.entries(notes)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}=${v ?? '?'}`)
    .join(',');
}
