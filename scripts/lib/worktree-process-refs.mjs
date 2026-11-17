/** Read-only process observations. Invocation wrappers are not worktree consumers. */
import { execFileSync, spawnSync } from 'node:child_process';
import { basename } from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;

function processTable() {
  try {
    const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
    const rows = out.split('\n').flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : [];
    });
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

function cwdTable(excluded, realpath) {
  let out = '';
  try {
    out = execFileSync('lsof', ['-n', '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    out = String(err.stdout ?? ''); // partial lsof output remains usable
  }
  let pid = null;
  const rows = out.split('\n').flatMap((line) => {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    return line.startsWith('n') && pid !== null && !excluded.has(pid) ? [{ pid, path: realpath(line.slice(1)) }] : [];
  });
  return rows.length ? rows : null;
}

function invocationWrappers(table, observerPid) {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  if (!byPid.has(observerPid)) return null;
  const excluded = new Set();
  const visited = new Set();
  let row = byPid.get(observerPid);
  while (row && !visited.has(row.pid)) {
    visited.add(row.pid);
    row = byPid.get(row.ppid);
    if (!row) break;
    const finish = /worktree-(?:finish|trim)\.mjs(?:[\s'"\\]|$)|worktree:(?:finish|trim)(?:\s|$)/.test(row.command);
    const wrapper = /(?:^|[\s/])(sh|zsh|bash|dash|fish|pnpm(?:\.c?js)?)(?:\s|$)/.test(row.command);
    if (finish && wrapper) excluded.add(row.pid);
  }
  return excluded;
}

function lsofFiles(out, excluded) {
  let pid = null;
  let file = null;
  const rows = [];
  const flush = () => {
    if (file && pid !== null && !excluded.has(pid)) rows.push({ pid, ...file });
    file = null;
  };
  for (const line of out.split('\n')) {
    const value = line.slice(1);
    switch (line[0]) {
      case 'p':
        flush();
        pid = Number(value);
        break;
      case 'f':
        flush();
        file = { fd: value };
        break;
      case 't':
        if (file) file.type = value;
        break;
      case 'd':
        if (file) file.pcb = value;
        break;
      case 'n':
        if (file) file.path = value;
        break;
    }
  }
  flush();
  return rows;
}

function openFileTable(excluded) {
  const result = spawnSync('lsof', ['-n', '-P', '-Fpftnd'], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Existing busy observations may use partial output; IPC quiescence requires complete descriptor observations.
  const all = lsofFiles(String(result.stdout ?? ''), excluded);
  const complete = !result.error && !result.signal && result.status === 0 && !result.stderr?.trim();
  const reference = ({ pid, path }) => ({ pid, path });
  const rows = all.filter((row) => ['REG', 'DIR'].includes(row.type) && row.path).map(reference);
  const executables = all.filter((row) => row.type === 'REG' && row.fd === 'txt').map(reference);
  const unixFiles = all.filter((row) => row.type === 'unix');
  return rows.length ? { rows, complete, executables, unixFiles } : null;
}

/** Only wrapper argv is excluded; ancestors' cwd and actual consumer argv still protect the target. */
export function observeProcessRefs({ excludePids = [], observerPid, realpath }) {
  const excluded = new Set(excludePids.filter((pid) => Number.isInteger(pid) && pid > 0));
  const table = processTable();
  if (table === null) return null;
  const wrappers = observerPid ? invocationWrappers(table, observerPid) : new Set();
  if (wrappers === null) return null;
  const cwdProcesses = cwdTable(excluded, realpath);
  const openFileProcesses = openFileTable(excluded);
  const argvProcesses = table.filter((row) => !excluded.has(row.pid) && !wrappers.has(row.pid));
  if (cwdProcesses === null || openFileProcesses === null || !argvProcesses.length) return null;
  return {
    cwds: cwdProcesses.map((row) => row.path),
    argv: argvProcesses.map((row) => row.command),
    cwdProcesses,
    argvProcesses,
    openFiles: openFileProcesses.rows.map((row) => row.path),
    openFileProcesses: openFileProcesses.rows,
    openFilesComplete: openFileProcesses.complete,
    executableProcesses: openFileProcesses.executables,
    unixFiles: openFileProcesses.unixFiles,
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** null=unknown, false=idle, object=matched reference; diagnostics never expose full argv. */
export function busyReference(dir, refs, realpath) {
  if (refs === null) return null;
  const forms = [...new Set([dir, realpath(dir)])];
  const underDir = (c) => forms.some((f) => c === f || c.startsWith(`${f}/`));
  const inArgv = (line) => forms.some((f) => new RegExp(`${escapeRe(f)}(/|\\s|$|["'])`).test(line));
  const cwd = refs.cwds.find(underDir);
  if (cwd) return { kind: 'cwd', pid: refs.cwdProcesses?.find((row) => row.path === cwd)?.pid };
  const file = refs.openFiles?.find(underDir);
  if (file) return { kind: 'open-file', pid: refs.openFileProcesses?.find((row) => row.path === file)?.pid };
  const argv = refs.argv.find(inArgv);
  if (!argv) return false;
  return {
    kind: 'argv',
    pid: refs.argvProcesses?.find((row) => row.command === argv)?.pid,
    executable: basename(argv.split(/\s/, 1)[0])
      .replace(/[^\w.-]/g, '')
      .slice(0, 80),
  };
}
