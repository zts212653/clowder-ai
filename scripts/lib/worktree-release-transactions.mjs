/** Automatic release recovery uses the same journal as owner finish, never a second retry store. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { busyProcess, git, lifecycleConfig, processRefs } from './worktree-reaper-probes.mjs';
import { RELEASE_ARCHIVES, verifyReleaseArchive, verifySourceOriginals } from './worktree-release-archive.mjs';

const binding = ['from', 'removedPath', 'head', 'owner', 'mergedPr', 'mergedAt', 'archivePath', 'restore', 'origin'];
export const releaseRoot = (repo) => join(dirname(repo), '.reaper-quarantine');
export function appendRelease(root, record, at = Date.now()) {
  mkdirSync(root, { recursive: true });
  const fd = openSync(join(root, 'ledger.jsonl'), 'a', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ ...record, at: new Date(at).toISOString() })}\n`);
    fsyncSync(fd); // In particular, the removing phase must reach storage before Git starts deleting.
  } finally {
    closeSync(fd);
  }
}

export function automaticReleaseTransactions(repo) {
  let lines;
  try {
    lines = readFileSync(join(releaseRoot(repo), 'ledger.jsonl'), 'utf8').split('\n');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = new Map();
  for (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !r ||
      r.repo !== repo ||
      r.action !== 'release' ||
      r.performedBy !== 'worktree-lifecycle' ||
      ['txn', 'from', 'removedPath', 'head', 'owner', 'sourceRef', 'archivePath', 'restore'].some(
        (key) => typeof r[key] !== 'string',
      )
    )
      continue;
    const previous = records.get(r.txn);
    if (
      r.state === 'pending' ||
      (previous && binding.every((key) => JSON.stringify(previous[key]) === JSON.stringify(r[key])))
    )
      records.set(r.txn, r);
  }
  return [...records.values()];
}

export function automaticReleasePaused(repo, path, head) {
  return automaticReleaseTransactions(repo).some(
    (r) => r.from === path && r.head === head && !['done', 'reconciled-removed'].includes(r.state),
  );
}

function requireOwnedArchive(root, r) {
  const parent = join(dirname(root), RELEASE_ARCHIVES);
  if (!/^[0-9a-f-]{36}$/.test(r.txn) || r.archivePath !== join(parent, r.txn))
    throw new Error('release transaction archive boundary mismatch');
  if (existsSync(parent) && (realpathSync(parent) !== parent || lstatSync(parent).uid !== process.getuid?.()))
    throw new Error('release archive root moved or owner changed');
  if (existsSync(r.archivePath) && lstatSync(r.archivePath).isSymbolicLink())
    throw new Error('release transaction archive is a symlink');
}

/** Only this transaction's duplicate copy and recovery refs, never the checkout or another archive. */
export function discardReleaseArchive(root, r) {
  requireOwnedArchive(root, r);
  rmSync(r.archivePath, { recursive: true, force: true });
  const refs = git(r.repo, ['for-each-ref', '--format=%(refname)', `refs/catcafe-releases/${r.txn}/`]);
  if (!refs.ok) throw new Error('aborted release refs unknown');
  for (const ref of refs.out.trim().split('\n').filter(Boolean)) {
    if (!git(r.repo, ['update-ref', '-d', ref]).ok) throw new Error('aborted release ref removal refused');
  }
}

export function verifyReleaseTransaction(root, r) {
  requireOwnedArchive(root, r);
  const digest =
    r.manifestSha256 ??
    createHash('sha256')
      .update(readFileSync(join(r.archivePath, 'manifest.json')))
      .digest('hex');
  const manifest = verifyReleaseArchive(r.archivePath, digest, r.repo);
  if (
    ['head', 'owner', 'sourceRef', 'mergedAt', 'mergedPr'].some((key) => manifest[key] !== r[key]) ||
    manifest.path !== r.from ||
    manifest.removedPath !== r.removedPath
  )
    throw new Error('interrupted release archive subject mismatch');
  return { manifest, manifestSha256: digest };
}

function sameCheckout(r) {
  const st = lstatSync(r.from);
  const head = git(r.from, ['rev-parse', 'HEAD']);
  const lifecycle = lifecycleConfig(r.from, '--worktree');
  return (
    r.sourceIdentity &&
    st.dev === r.sourceIdentity.dev &&
    st.ino === r.sourceIdentity.ino &&
    head.ok &&
    head.out.trim() === r.head &&
    lifecycle?.owner === r.owner &&
    lifecycle.createdAt === r.lifecycle?.createdAt &&
    JSON.stringify(lifecycle.origin) === JSON.stringify(r.origin)
  );
}

/** Called before inventory by the existing sweep. An interrupted removal is never relabelled a normal finish. */
export function reconcileAutomaticReleases(repo, { now = Date.now(), cwdProbe } = {}) {
  const pending = automaticReleaseTransactions(repo).filter((r) => r.state === 'pending');
  const offset = pending.length ? (Math.floor(now / 300000) % Math.ceil(pending.length / 4)) * 4 : 0;
  const selected = pending.slice(offset, offset + 4);
  const result = { reconciled: 0, warnings: [] };
  if (!selected.length) return result;
  const refs = cwdProbe ? cwdProbe() : processRefs({ excludePids: [process.pid], observerPid: process.pid });
  const registration = git(repo, ['worktree', 'list', '--porcelain']);
  if (!registration.ok || refs === null) throw new Error('automatic release reconciliation observations unavailable');
  for (const r of selected) {
    // The CLI writer and any orphan cp/git process reference one of these paths. A recycled PID alone is not occupancy.
    if (busyProcess(r.from, refs) !== false || busyProcess(r.archivePath, refs) !== false) continue;
    try {
      let resolved;
      if (
        !existsSync(r.from) &&
        !existsSync(r.removedPath) &&
        ![r.from, r.removedPath].some((path) => registration.out.split('\n').includes(`worktree ${path}`))
      ) {
        const { manifestSha256 } = verifyReleaseTransaction(releaseRoot(repo), r);
        resolved = {
          ...r,
          state: 'reconciled-removed',
          manifestSha256,
          reason: 'completion receipt interrupted; removal and archive now verified',
        };
      } else if (r.phase === 'preserving' && existsSync(r.from) && sameCheckout(r)) {
        if (existsSync(join(r.archivePath, 'manifest.json'))) {
          const { manifest } = verifyReleaseTransaction(releaseRoot(repo), r);
          verifySourceOriginals({ path: r.from }, manifest);
        }
        discardReleaseArchive(releaseRoot(repo), r);
        resolved = {
          ...r,
          state: 'aborted',
          reason: 'archive copy interrupted before removal; duplicate copy discarded; automatic retry paused',
        };
      } else {
        resolved = {
          ...r,
          state: 'interrupted',
          reason: 'removal may be partial or checkout changed; preserve the archive and finish manually',
        };
      }
      appendRelease(releaseRoot(repo), resolved, now);
      result.reconciled++;
    } catch (error) {
      appendRelease(
        releaseRoot(repo),
        { ...r, state: 'interrupted', reason: `${error.message}; automatic retry paused; preserve recovery material` },
        now,
      );
      result.warnings.push({ path: r.from, reason: error.message });
    }
  }
  return result;
}
