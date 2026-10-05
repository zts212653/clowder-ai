/**
 * Filesystem / git / process probes for the worktree reaper.
 *
 * Contract: every probe returns `null` when it could not determine the answer. Callers must treat
 * `null` as "unknown" (→ review), never as "clean", "idle", "unused" or "undeclared".
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;
export const WALK_CAP = 5000;

/** Run git; returns { ok, code, out }. Never throws. `env` adds variables for this call only. */
export function git(cwd, args, env = {}) {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Read-only probing: without this `git status` refreshes (rewrites) the index, which both
      // mutates the directory being judged and fakes "recent activity" for the next run.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
    });
    return { ok: true, code: 0, out };
  } catch (err) {
    return { ok: false, code: typeof err.status === 'number' ? err.status : null, out: String(err.stdout ?? '') };
  }
}

export function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Birth declaration written by scripts/worktree-new.mjs. Read ONLY from the per-worktree config
 * (`--worktree`) or the clone's own config (`--local`), so a key set in the shared repository config
 * can never make every worktree look declared. `{}` = undeclared; null = unreadable.
 */
export function lifecycleConfig(dir, scope) {
  const res = git(dir, ['config', scope, '--get-regexp', '^catcafe\\.lifecycle\\.']);
  if (!res.ok) return res.code === 1 ? {} : null; // 1 = no matching key
  // git lower-cases variable names; map them back to the declared camelCase keys.
  const names = { owner: 'owner', policy: 'policy', createdat: 'createdAt', expiresat: 'expiresAt' };
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of res.out.split('\n').filter(Boolean)) {
    const i = line.indexOf(' ');
    const key = names[line.slice('catcafe.lifecycle.'.length, i).toLowerCase()];
    if (key) out[key] = line.slice(i + 1);
  }
  return out;
}

const PROVIDERS = '(agent|agents|augment|claude|codex|cursor|gemini|kimi|kiro|trae)';
const SKILL_LINK = new RegExp(`^\\.${PROVIDERS}/skills/[^/]+$`);
const SKILL_DIR = new RegExp(`^\\.${PROVIDERS}(/skills)?$`);

/**
 * A sync:skills link: `.<provider>/skills/<name>` whose target resolves into this checkout's tracked
 * `cat-cafe-skills/`. Such links are not "dirty" work; everything else untracked is.
 */
export function isSkillLinkTree(root, abs) {
  const skillsRoot = `${join(root, 'cat-cafe-skills')}/`;
  let seen = 0;
  const walk = (p) => {
    if (++seen > WALK_CAP) return false;
    const rel = relative(root, p);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      return SKILL_LINK.test(rel) && `${resolve(dirname(p), readlinkSync(p))}/`.startsWith(skillsRoot);
    }
    if (!st.isDirectory() || !SKILL_DIR.test(rel)) return false;
    return readdirSync(p).every((child) => walk(join(p, child)));
  };
  try {
    return walk(abs);
  } catch {
    return false;
  }
}

/** Tracked changes and untracked (non-skill-link) count from `git status`; all-null on failure. */
export function statusFacts(dir) {
  const res = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!res.ok) return { trackedChanges: null, untrackedPreserved: null };
  const fields = res.out.split('\0');
  let trackedChanges = 0;
  let untrackedPreserved = 0;
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    if (xy === '??') {
      if (!isSkillLinkTree(dir, join(dir, rec.slice(3).replace(/\/$/, '')))) untrackedPreserved++;
    } else if (xy !== '!!') {
      trackedChanges++;
      if (xy[0] === 'R' || xy[0] === 'C') i++; // rename/copy carries the source path as the next field
    }
  }
  return { trackedChanges, untrackedPreserved };
}

function mtimeMs(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Epoch ms of the newest git activity: HEAD commit time or the last HEAD reflog entry (commit, checkout,
 * reset). null when either cannot be read. `git worktree move` and a directory rename write neither, so a
 * quarantined checkout keeps its pre-quarantine value until someone actually works in it.
 */
export function lastGitActivityMs(dir) {
  const ct = git(dir, ['log', '-1', '--format=%ct']);
  const commitMs = ct.ok ? Number.parseInt(ct.out.trim(), 10) * 1000 : Number.NaN;
  if (!Number.isFinite(commitMs)) return null;
  const rl = git(dir, ['reflog', '-1', '--date=unix', '--format=%gd', 'HEAD']);
  const m = rl.ok ? rl.out.match(/@\{(\d+)\}/) : null;
  if (!m) return null;
  return Math.max(commitMs, Number(m[1]) * 1000);
}

/**
 * Days since the newest of: git activity (above) and the top-level directory change. Deliberately NOT the
 * index mtime: any `git status` (editors, prompts, audits) rewrites it, so it measures "someone looked",
 * not "someone worked". All signals required.
 */
export function idleDays(dir, now) {
  const gitMs = lastGitActivityMs(dir);
  const dirMs = mtimeMs(dir);
  if (gitMs === null || dirMs === null) return null;
  return (now - Math.max(gitMs, dirMs)) / 86_400_000;
}

/** true / false / null for "HEAD is an ancestor of <ref>" in `repo`'s object store. */
export function isAncestor(repo, head, ref) {
  if (!head) return null;
  const res = git(repo, ['merge-base', '--is-ancestor', head, ref]);
  if (res.ok) return true;
  return res.code === 1 ? false : null;
}

/**
 * true / false / null for "everything <head> changed is already in <ref>". Ancestry covers merge commits and
 * fast-forwards; a squash (or rebase) merge leaves head outside ref's history, so the fallback asks git to
 * merge head into ref: if the merged tree equals ref's own tree, head adds nothing ref lacks. Work committed
 * after a squash merge, or a branch only partly merged, changes the merged tree → false. Conflicts → false.
 *
 * The simulated merge writes tree/blob objects. They go to a throwaway object directory (the inspected
 * repository's objects are only read, as an alternate), so a probe never changes the repo it judges.
 */
export function isContainedIn(repo, head, ref) {
  const anc = isAncestor(repo, head, ref);
  if (anc !== false) return anc;
  const objects = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const refTree = git(repo, ['rev-parse', `${ref}^{tree}`]);
  if (!objects.ok || !refTree.ok) return null;
  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'reaper-merge-tree-'));
    const merged = git(repo, ['merge-tree', '--write-tree', '--no-messages', ref, head], {
      GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.out.trim(),
    });
    if (!merged.ok) return merged.code === 1 ? false : null; // 1 = conflicts
    return merged.out.split('\n')[0].trim() === refTree.out.trim();
  } catch {
    return null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function psCommandLines() {
  try {
    const out = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
    const lines = out.split('\n').filter(Boolean);
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

function lsofCwds() {
  let out = '';
  try {
    out = execFileSync('lsof', ['-n', '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    out = String(err.stdout ?? ''); // lsof exits 1 when some processes are unreadable; output is still valid
  }
  const cwds = out
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => l.slice(1));
  return cwds.length > 0 ? cwds.map(safeRealpath) : null;
}

/** Live processes' cwds and command lines; null (unknown) when either probe failed. */
export function processRefs() {
  const cwds = lsofCwds();
  const argv = psCommandLines();
  return cwds === null || argv === null ? null : { cwds, argv };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isBusy(dir, refs) {
  if (refs === null) return null;
  const forms = [...new Set([dir, safeRealpath(dir)])];
  const underDir = (c) => forms.some((f) => c === f || c.startsWith(`${f}/`));
  // Match the dir as a whole path token inside a command line (not `…/cat-cafe-x-2` for `…/cat-cafe-x`).
  const inArgv = (line) => forms.some((f) => new RegExp(`${escapeRe(f)}(/|\\s|$|["'])`).test(line));
  return refs.cwds.some(underDir) || refs.argv.some(inArgv);
}

const JUNK_FILES = new Set(['.DS_Store']);

export function isHollowTree(dir) {
  let seen = 0;
  const walk = (p) => {
    if (++seen > WALK_CAP) return false;
    return readdirSync(p, { withFileTypes: true }).every((d) => {
      if (d.isDirectory()) return walk(join(p, d.name));
      return d.isFile() && JUNK_FILES.has(d.name);
    });
  };
  return walk(dir);
}

/** true when the tree holds no files at all — only (nested) directories and Finder junk. */
export function isHollow(dir) {
  try {
    return isHollowTree(dir);
  } catch {
    return null;
  }
}

/** 'clone' (own .git dir), 'remnant' (.git file of a pruned worktree), 'plain', or null. */
export function checkoutKind(dir) {
  try {
    const st = lstatSync(join(dir, '.git'));
    return st.isDirectory() ? 'clone' : 'remnant';
  } catch (err) {
    return err.code === 'ENOENT' ? 'plain' : null;
  }
}

export function diskKb(dir) {
  try {
    const out = execFileSync('du', ['-sk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Number.parseInt(out, 10);
  } catch {
    return null;
  }
}
