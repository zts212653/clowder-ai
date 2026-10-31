/** Trim only compiler caches: production builds, runtime caches and dependencies stay usable. */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ownedWorktreeFacts } from '../worktree-finish.mjs';
import { requireNoDurableConsumers } from './worktree-consumers.mjs';
import { busyProcess, git, processRefs, safeRealpath } from './worktree-reaper-probes.mjs';

const CACHE_PATH = 'packages/web/.next/cache';
const CACHES = ['webpack', 'swc', 'next-minifier'];
const STAGING = '.cat-cafe-trim';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function gitValue(root, args) {
  const result = git(root, args);
  if (!result.ok) throw new Error(`trim git ${args[0]} refused`);
  return result.out.trim();
}

function guard(opts) {
  const entry = ownedWorktreeFacts(opts);
  if (entry.locked || entry.lifecycle.policy === 'never') throw new Error('locked or never-policy worktree');
  if (
    /^cat-cafe-(?:alpha|main-test)(?:-|$)/.test(entry.name) ||
    /^refs\/heads\/(?:alpha|main-test)\//.test(entry.branch ?? '')
  )
    throw new Error('protected Alpha worktree');
  const cwd = safeRealpath(process.cwd());
  if (cwd === opts.path || cwd.startsWith(`${opts.path}/`))
    throw new Error('run trim from outside the target worktree');
  const refs = opts.cwdProbe ? opts.cwdProbe() : processRefs({ excludePids: [process.pid], observerPid: process.pid });
  const busy = busyProcess(opts.path, refs);
  if (busy === null) throw new Error('process state unknown');
  if (busy) throw new Error(`busy worktree: ${busy.kind} pid=${busy.pid ?? 'unknown'}`);
  requireNoDurableConsumers(opts);
  return entry;
}

/** Every existing ancestor must belong to this checkout; never follow a cache mount/symlink. */
function localDirectory(root, relative) {
  let path = root;
  const device = lstatSync(root).dev;
  for (const part of relative.split('/')) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device || safeRealpath(path) !== path)
      throw new Error(`cache directory is not local: ${relative}`);
  }
  return true;
}

function assertUntracked(root, relative) {
  if (gitValue(root, ['ls-files', '-z', '--', `:(literal)${relative}`]))
    throw new Error(`cache contains tracked source: ${relative}`);
}

function pendingTransactions(root) {
  const staging = `${CACHE_PATH}/${STAGING}`;
  const pending = [];
  if (localDirectory(root, staging)) {
    assertUntracked(root, staging);
    for (const txn of readdirSync(join(root, staging))) {
      if (!UUID.test(txn) || !localDirectory(root, `${staging}/${txn}`)) throw new Error('unknown trim staging entry');
      for (const name of readdirSync(join(root, staging, txn))) {
        if (!CACHES.includes(name) || !localDirectory(root, `${staging}/${txn}/${name}`))
          throw new Error('unknown data in trim staging');
      }
      pending.push(`${staging}/${txn}`);
    }
  }
  return pending;
}

function inventory(root) {
  if (!localDirectory(root, CACHE_PATH)) return { caches: [], pending: [] };
  const caches = CACHES.filter((name) => localDirectory(root, `${CACHE_PATH}/${name}`));
  for (const name of caches) assertUntracked(root, `${CACHE_PATH}/${name}`);
  return { caches, pending: pendingTransactions(root) };
}

function directoryBytes(path) {
  let total = 0;
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isDirectory()) total += directoryBytes(child);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

function diskFreeBytes(path) {
  const stat = statfsSync(path);
  return stat.bavail * stat.bsize;
}

function options(input) {
  const opts = { ...input, path: safeRealpath(resolve(input.path)), repo: safeRealpath(input.repo) };
  for (const key of ['owner', 'sourceRef']) {
    if (typeof opts[key] !== 'string' || !opts[key].trim() || opts[key].length > 2000 || /[\r\n\0]/.test(opts[key]))
      throw new Error(`required ${key}`);
  }
  return opts;
}

export function trimWorktree(input) {
  const opts = options(input);
  const entry = guard(opts);
  const found = inventory(opts.path);
  if (!found.caches.length && !found.pending.length)
    return { state: 'unchanged', path: opts.path, owner: opts.owner, sourceRef: opts.sourceRef };
  const gitDir = gitValue(opts.path, ['rev-parse', '--absolute-git-dir']);
  if (safeRealpath(gitDir) !== gitDir) throw new Error('private Git metadata is not local');
  const txn = randomUUID();
  const staging = `${CACHE_PATH}/${STAGING}/${txn}`;
  const paths = [...found.caches.map((name) => `${CACHE_PATH}/${name}`), ...found.pending];
  const receipt = {
    v: 1,
    action: 'trim',
    txn,
    path: opts.path,
    owner: opts.owner,
    sourceRef: opts.sourceRef,
    head: entry.head,
    paths,
    observedLogicalBytes: paths.reduce((sum, path) => sum + directoryBytes(join(opts.path, path)), 0),
    diskFreeBytesBefore: diskFreeBytes(opts.path),
    observation: 'process+durable+rename',
  };
  const journal = join(gitDir, 'cat-cafe-trim.jsonl');
  const append = (state, extra = {}) => {
    const fd = openSync(
      journal,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      appendFileSync(fd, `${JSON.stringify({ ...receipt, state, at: new Date().toISOString(), ...extra })}\n`);
    } finally {
      closeSync(fd);
    }
  };
  append('pending');
  // Re-read after potentially slow size inventory, immediately before detaching.
  const current = guard(opts);
  if (current.head !== entry.head || JSON.stringify(current.lifecycle) !== JSON.stringify(entry.lifecycle))
    throw new Error('worktree identity changed before trim');
  if (JSON.stringify(inventory(opts.path)) !== JSON.stringify(found))
    throw new Error('cache inventory changed before trim');
  try {
    if (found.caches.length) {
      mkdirSync(join(opts.path, staging), { recursive: true, mode: 0o700 });
      for (const name of found.caches) renameSync(join(opts.path, CACHE_PATH, name), join(opts.path, staging, name));
      // Only delete the detached generation. A compiler may already have created a new cache.
      rmSync(join(opts.path, staging), { recursive: true });
    }
    for (const pending of found.pending) rmSync(join(opts.path, pending), { recursive: true });
    const result = { ...receipt, state: 'trimmed', diskFreeBytesAfter: diskFreeBytes(opts.path), journal };
    append('trimmed', { diskFreeBytesAfter: result.diskFreeBytesAfter });
    return result;
  } catch (cause) {
    const error = new Error(
      `trim incomplete: ${cause.code ?? cause.message}; rerun worktree:trim to clear detached caches`,
      { cause },
    );
    error.receipt = { ...receipt, state: 'incomplete', stagingPath: join(opts.path, staging), journal };
    throw error;
  }
}
