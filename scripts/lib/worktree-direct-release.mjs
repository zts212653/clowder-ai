/** Explicit owner finish removes a checkout after a verified original-only archive. */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './worktree-reaper-probes.mjs';
import {
  createReleaseArchive,
  RELEASE_ARCHIVES,
  releaseRestoreCommand,
  verifyReleaseArchive,
  verifySourceOriginals,
} from './worktree-release-archive.mjs';

function append(root, record, at) {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date(at).toISOString(), ...record })}\n`);
}

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
  const base = {
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
    ...(entry.mergedAt ? { mergedAt: entry.mergedAt } : {}),
    ...(entry.mergedPr ? { mergedPr: entry.mergedPr } : {}),
    restore,
  };
  append(root, { ...base, state: 'pending' }, clock());
  const { manifest, manifestSha256 } = createReleaseArchive({ repo, entry, archivePath, txn });
  verifyReleaseArchive(archivePath, manifestSha256, repo);
  validate();
  verifySourceOriginals(entry, manifest);
  const before = freeBytes(dirname(entry.path));
  // Hashing originals can take time. Refresh the caller's process/job/owner
  // observations at the destructive boundary; this is a probe, not an admission lock.
  validate();
  let done;
  try {
    const result = git(repo, ['worktree', 'remove', entry.path]);
    if (!result.ok || existsSync(entry.path)) throw new Error('git worktree remove refused');
    const after = freeBytes(dirname(entry.path));
    done = { ...base, state: 'done', manifestSha256, diskFreeBytesBefore: before, diskFreeBytesAfter: after };
    append(root, done, clock());
  } catch (cause) {
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
