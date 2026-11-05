/** Explicit owner finish removes a checkout after a verified original-only archive. */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmdirSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './worktree-reaper-probes.mjs';
import {
  createReleaseArchive,
  RELEASE_ARCHIVES,
  releaseRestoreCommand,
  verifyReleaseArchive,
  verifySourceOriginals,
} from './worktree-release-archive.mjs';
import { appendRelease as append, discardReleaseArchive } from './worktree-release-transactions.mjs';

function freeBytes(path) {
  const st = statfsSync(path);
  return st.bavail * st.bsize;
}

export function removeFinishedWorktree({ repo, root, entry, validate, actor, authorizationRef, clock = Date.now }) {
  if (typeof actor !== 'string' || !actor.trim() || typeof authorizationRef !== 'string' || !authorizationRef.trim())
    throw new Error('release actor and authorization source required');
  const txn = randomUUID();
  const archivePath = join(dirname(root), RELEASE_ARCHIVES, txn);
  const restore = releaseRestoreCommand(repo, entry, archivePath);
  const automatic = actor === 'worktree-lifecycle';
  const st = automatic ? lstatSync(entry.path) : null;
  const base = {
    repo,
    action: 'release',
    txn,
    from: entry.originalPath ?? entry.path,
    removedPath: entry.path,
    archivePath,
    owner: entry.lifecycle.owner,
    performedBy: actor,
    authorizationRef,
    sourceRef: entry.finishSourceRef,
    head: entry.head,
    ...(entry.lifecycle.origin ? { origin: entry.lifecycle.origin } : {}),
    ...(entry.mergedAt ? { mergedAt: entry.mergedAt } : {}),
    ...(entry.mergedPr ? { mergedPr: entry.mergedPr } : {}),
    restore,
    ...(automatic
      ? { processPid: process.pid, sourceIdentity: { dev: st.dev, ino: st.ino }, lifecycle: entry.lifecycle }
      : {}),
  };
  let phase = 'preserving';
  append(root, { ...base, state: 'pending', ...(automatic ? { phase } : {}) }, clock());
  let done;
  let manifest;
  try {
    const archive = createReleaseArchive({ repo, entry, archivePath, txn });
    manifest = archive.manifest;
    const { manifestSha256 } = archive;
    verifyReleaseArchive(archivePath, manifestSha256, repo);
    validate();
    verifySourceOriginals(entry, manifest);
    const before = freeBytes(dirname(entry.path));
    // Refresh observations after hashing, immediately before the destructive boundary.
    validate();
    if (automatic) append(root, { ...base, state: 'pending', phase: 'removing', manifestSha256 }, clock());
    phase = 'removing';
    const result = git(repo, ['worktree', 'remove', entry.path]);
    if (!result.ok || existsSync(entry.path)) throw new Error('git worktree remove refused');
    const after = freeBytes(dirname(entry.path));
    done = { ...base, state: 'done', manifestSha256, diskFreeBytesBefore: before, diskFreeBytesAfter: after };
    append(root, done, clock());
  } catch (cause) {
    if (automatic && existsSync(entry.path)) {
      try {
        // Git can fail after partially removing a tree. Keep the sole recovery copy in that case.
        if (phase === 'removing') verifySourceOriginals(entry, manifest);
        discardReleaseArchive(root, base);
        append(root, { ...base, state: 'aborted', reason: `${cause.message}; automatic retry paused` }, clock());
      } catch (cleanup) {
        append(
          root,
          { ...base, state: 'interrupted', reason: `${cause.message}; ${cleanup.message}; automatic retry paused` },
          clock(),
        );
      }
    }
    const status = existsSync(entry.path)
      ? 'worktree release incomplete'
      : 'working copy removed but release completion failed';
    const error = new Error(`${status}: txn=${txn}; ${cause.message}`, { cause });
    error.recovery = { state: 'pending', txn, archivePath, restore };
    throw error;
  }
  if (entry.path.startsWith(`${root}/`)) {
    try {
      rmdirSync(dirname(entry.path));
    } catch {}
  }
  return done;
}

export function directReleaseReceipt({ repo, root, path, owner, sourceRef }) {
  let lines;
  try {
    lines = readFileSync(join(root, 'ledger.jsonl'), 'utf8').split('\n');
  } catch {
    return null;
  }
  const records = new Map();
  for (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.from !== path) continue;
    if (r.action === 'quarantine') {
      records.delete(path);
      continue;
    }
    if (r.action !== 'release') continue;
    const previous = records.get(r.from);
    if (r.state === 'pending') records.set(r.from, { pending: r, done: null });
    else if (
      r.state === 'done' &&
      previous?.pending.txn === r.txn &&
      previous.done === null &&
      [
        'archivePath',
        'removedPath',
        'owner',
        'performedBy',
        'authorizationRef',
        'sourceRef',
        'head',
        'restore',
        'mergedAt',
        'mergedPr',
      ].every((key) => previous.pending[key] === r[key]) &&
      Number.isFinite(Date.parse(r.at)) &&
      Date.parse(r.at) >= Date.parse(previous.pending.at)
    )
      records.set(r.from, { ...previous, done: r });
    else records.delete(r.from);
  }
  const r = records.get(path)?.done;
  if (!r || r.owner !== owner || r.sourceRef !== sourceRef || existsSync(path) || existsSync(r.removedPath))
    return null;
  const registration = git(repo, ['worktree', 'list', '--porcelain']);
  if (!registration.ok || [path, r.removedPath].some((p) => registration.out.split('\n').includes(`worktree ${p}`)))
    return null;
  const archiveRoot = join(dirname(root), RELEASE_ARCHIVES);
  if (dirname(r.archivePath) !== archiveRoot) throw new Error('release archive outside archive root');
  const manifest = verifyReleaseArchive(r.archivePath, r.manifestSha256, repo);
  if (
    manifest.repo !== repo ||
    manifest.path !== path ||
    manifest.removedPath !== r.removedPath ||
    manifest.head !== r.head ||
    manifest.owner !== owner ||
    manifest.sourceRef !== sourceRef ||
    manifest.mergedAt !== r.mergedAt ||
    manifest.mergedPr !== r.mergedPr
  )
    throw new Error('release archive receipt mismatch');
  return {
    state: 'released',
    storageDisposition: 'removed',
    path,
    owner,
    sourceRef,
    head: r.head,
    ...(r.mergedAt ? { mergedAt: r.mergedAt } : {}),
    ...(r.mergedPr ? { mergedPr: r.mergedPr } : {}),
    archivePath: r.archivePath,
    restore: r.restore,
    diskFreeBytesBefore: r.diskFreeBytesBefore,
    diskFreeBytesAfter: r.diskFreeBytesAfter,
  };
}
