/** Identity and occupancy proof shared by the parent and the closed-admission validator. */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { busyProcess, git, safeRealpath } from './worktree-reaper-probes.mjs';

export const fail = (message) => {
  throw new Error(`fsmonitor: ${message}`);
};
export const identity = (st) => `${st.dev}:${st.ino}:${st.uid}`;
export const mustGit = (path, args) => {
  const result = git(path, args);
  if (!result.ok) fail('Git scope unknown');
  return result.out.trim();
};

function nativeEvidence(pid, refs, executable) {
  const command = refs.argvProcesses?.find((row) => row.pid === pid)?.command;
  const match = command?.match(/^(.+) fsmonitor--daemon run(?: (?:--detach|--ipc-threads=\d+))*$/);
  const argv = !!match && basename(match[1]) === 'git';
  const image =
    refs.executableProcesses?.some((row) => {
      if (row.pid !== pid) return false;
      try {
        return identity(statSync(row.path)) === executable;
      } catch {
        return false;
      }
    }) === true;
  return { argv, image };
}
export function nativeMonitor(pid, refs, executable) {
  const { argv, image } = nativeEvidence(pid, refs, executable);
  return argv && image;
}

export function withoutPids(refs, pids) {
  const result = { ...refs };
  for (const [rows, paths, field] of [
    ['cwdProcesses', 'cwds', 'path'],
    ['argvProcesses', 'argv', 'command'],
    ['openFileProcesses', 'openFiles', 'path'],
  ]) {
    if (!Array.isArray(refs[rows])) fail('process identity observations unknown');
    result[rows] = refs[rows].filter((row) => !pids.includes(row.pid));
    result[paths] = result[rows].map((row) => row[field]);
  }
  return result;
}

export function requireIdle(path, gitDir, refs) {
  if (busyProcess(path, refs) !== false || busyProcess(gitDir, refs) !== false)
    fail('busy worktree or private Git metadata; preserve live/unknown consumers');
}

export function requireSocketScope(entry, gitDir, before) {
  const common = mustGit(entry.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (
    safeRealpath(gitDir) !== gitDir ||
    dirname(gitDir) !== join(common, 'worktrees') ||
    mustGit(entry.path, ['rev-parse', '--show-toplevel']) !== entry.path ||
    readFileSync(join(gitDir, 'gitdir'), 'utf8').trim() !== join(entry.path, '.git')
  )
    fail('private Git metadata scope unknown');
  if (git(entry.path, ['config', '--get', 'fsmonitor.socketDir']).code !== 1)
    fail('custom or unknown socket directory; retain for inspection');
  if (before && (!before.isSocket() || before.uid !== process.getuid?.())) fail('IPC type or owner unknown');
  if (before && (before.mode & 0o7000) !== 0) fail('IPC special permission bits unknown');
  return { common, executable: identity(statSync(join(mustGit(entry.path, ['--exec-path']), 'git'))) };
}

export function requireNativeIdentity(entry, gitDir, pid, refs, executable) {
  const files = refs.openFileProcesses?.filter((row) => row.pid === pid).map((row) => row.path);
  const { argv, image } = nativeEvidence(pid, refs, executable);
  const native = argv && image;
  const metadata = files?.includes(gitDir) === true;
  const checkout = files?.includes(entry.path) === true;
  if (!native || !metadata || !checkout)
    fail(
      `IPC held by an unproven process pid=${pid} argv=${argv} executable=${image} metadata=${metadata} checkout=${checkout}`,
    );
}
