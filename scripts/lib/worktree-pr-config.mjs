/** PR association and its correction history share Git's one private-config transaction. */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { git } from './worktree-reaper-probes.mjs';

export function writePrBinding(entry, sourceRef, history, validate) {
  const location = git(entry.path, ['rev-parse', '--path-format=absolute', '--git-path', 'config.worktree']);
  if (!location.ok) throw new Error('private worktree config unavailable');
  const config = location.out.trim();
  const lock = `${config}.lock`;
  // The standard Git lock also excludes ordinary `git config --worktree` writers.
  // An existing lock is never removed, retried or treated as ours.
  const fd = openSync(lock, 'wx', statSync(config).mode & 0o777);
  let ownsLock = true;
  try {
    try {
      writeFileSync(fd, readFileSync(config));
    } finally {
      closeSync(fd);
    }
    const set = (key, value) => {
      if (!git(entry.path, ['config', '--file', lock, `catcafe.lifecycle.${key}`, value]).ok)
        throw new Error('could not prepare PR binding config');
    };
    set('prSource', sourceRef);
    if (history !== undefined) set('prBindingHistory', JSON.stringify(history));
    const finalFd = openSync(lock, 'r');
    try {
      fsyncSync(finalFd);
    } finally {
      closeSync(finalFd);
    }
    validate();
    renameSync(lock, config);
    ownsLock = false;
  } finally {
    if (ownsLock) rmSync(lock, { force: true });
  }
}
