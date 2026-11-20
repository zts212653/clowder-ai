/** A kernel-held startup mutex lasts through archive/removal; journal proof survives an interrupted owner. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fail, identity } from './worktree-fsmonitor-identity.mjs';

export const ADMISSION_KIND = 'catcafe-fsmonitor-admission';
const IPC = 'fsmonitor--daemon.ipc';
const FLOCK = 'use Fcntl qw(:flock); open(my $f,"+<&=3") or exit 2; flock($f,LOCK_EX|LOCK_NB) or exit 1;';
export function optionalStat(path, bigint = false) {
  try {
    return lstatSync(path, { bigint });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function lockedFd(path, create) {
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT | constants.O_EXCL : 0),
    0o600,
  );
  const st = fstatSync(fd);
  if (!st.isFile() || st.uid !== process.getuid?.() || st.size > 65536) {
    closeSync(fd);
    fail('IPC startup lock unknown');
  }
  const result = spawnSync('/usr/bin/perl', ['-e', FLOCK], { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 2000 });
  if (result.error || result.signal || result.status !== 0) {
    try {
      const current = optionalStat(path);
      if (create && current?.size === 0 && identity(current) === identity(st)) unlinkSync(path);
    } finally {
      closeSync(fd);
    }
    fail('IPC admission already active or unknown');
  }
  if (identity(optionalStat(path) ?? {}) !== identity(st)) {
    closeSync(fd);
    fail('IPC startup lock identity changed');
  }
  return { fd, path, lockIdentity: identity(st) };
}
function records(guard) {
  const st = fstatSync(guard.fd);
  if (st.size < 1 || st.size > 65536) fail('IPC journal unknown');
  const buffer = Buffer.alloc(st.size);
  if (readSync(guard.fd, buffer, 0, buffer.length, 0) !== buffer.length) fail('IPC journal incomplete');
  const boundary = buffer.lastIndexOf(10) + 1;
  if (!boundary) fail('IPC journal initialization unknown');
  guard.tornTail = boundary < buffer.length ? boundary : undefined;
  try {
    return buffer
      .subarray(0, boundary)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch {
    fail('IPC journal incomplete or unknown');
  }
}
function scoped(base, entry, scope) {
  // The original absolute staging root is journaled. A retry's TMPDIR is not
  // provenance; deletion still requires the recorded control inode/owner below.
  if (
    base.kind !== ADMISSION_KIND ||
    base.v !== 1 ||
    base.path !== entry.path ||
    base.head !== entry.head ||
    base.owner !== entry.lifecycle.owner ||
    base.executable !== scope.executable ||
    !/^[a-f0-9-]{36}$/.test(base.nonce ?? '') ||
    typeof base.controlPath !== 'string' ||
    !isAbsolute(base.controlPath) ||
    resolve(base.controlPath) !== base.controlPath ||
    basename(base.controlPath) !== `cat-cafe-fsmonitor-${base.nonce}` ||
    (base.coldSocket !== undefined &&
      (base.identity !== null ||
        typeof base.coldSocket !== 'string' ||
        !/^\d+:\d+:\d+:\d+:\d+:\d+$/.test(base.coldSocket))) ||
    (!(base.identity === null && base.monitorPid === null && base.mode === null) &&
      (!Number.isSafeInteger(base.monitorPid) ||
        base.monitorPid < 1 ||
        !Number.isInteger(base.mode) ||
        base.mode < 0 ||
        base.mode > 0o777))
  )
    fail('IPC journal scope unknown');
}
function append(guard, event) {
  const line = `${JSON.stringify(event)}\n`;
  if (writeSync(guard.fd, line, fstatSync(guard.fd).size, 'utf8') !== Buffer.byteLength(line))
    fail('IPC journal write incomplete');
  fsyncSync(guard.fd);
}
function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}
function proof(base, events, socket) {
  const qualified = events.findLast(
    (event) => event.phase === 'qualified' && event.nonce === base.nonce && event.identity === base.identity,
  );
  const control = events.findLast((event) => event.phase === 'control' && event.nonce === base.nonce);
  if (
    !qualified ||
    !/^[a-f0-9-]{36}$/.test(qualified.attempt ?? '') ||
    !/^\d+$/.test(qualified.ctimeNs ?? '') ||
    !control ||
    control.path !== base.controlPath
  )
    return false;
  if (
    events.some((event) => event.phase === 'stopped' && event.nonce === base.nonce && event.identity === base.identity)
  )
    return true;
  const st = optionalStat(socket, true);
  return (
    !!qualified &&
    !!st &&
    identity(st) === base.identity &&
    (st.mode & 0o777n) === 0n &&
    st.ctimeNs.toString() === qualified.ctimeNs &&
    isDead(base.monitorPid)
  );
}
function cleanupControl(base, events) {
  const control = events.findLast((event) => event.phase === 'control' && event.nonce === base.nonce);
  const path = base.controlPath;
  const st = optionalStat(path);
  if (!st) return;
  const preserve = () => process.stderr.write(`fsmonitor: preserve incomplete or changed control staging ${path}\n`);
  // Unpublished controls are outside worktree metadata: preserve unknown objects without
  // retaining our own startup mutex forever. Never infer an inode from its random name.
  if (
    !control ||
    control.path !== path ||
    !st.isDirectory() ||
    st.uid !== process.getuid?.() ||
    identity(st) !== control.identity
  )
    return preserve();
  const remote = `.git-fsmonitor-${createHash('sha1').update(base.path).digest('hex')}`;
  const names = new Set(['HEAD', 'commondir', IPC, remote]);
  for (const item of control.files ?? []) {
    if (!names.delete(item.name)) return preserve();
    const child = join(path, item.name);
    const st = optionalStat(child);
    if (st && identity(st) !== item.identity) return preserve();
  }
  if (names.size || readdirSync(path).some((name) => !control.files.some((item) => item.name === name)))
    return preserve();
  for (const item of control.files) if (optionalStat(join(path, item.name))) unlinkSync(join(path, item.name));
  rmdirSync(path);
}
function reconcile(guard, entry, scope) {
  const [base, ...events] = records(guard);
  scoped(base, entry, scope);
  if (guard.tornTail !== undefined) {
    ftruncateSync(guard.fd, guard.tornTail); // Only an uncommitted append, after exact scope and exclusive lease proof.
    fsyncSync(guard.fd);
  }
  guard.base = base;
  if (base.identity === null) return guard; // Startup-only guards never mutate the socket during recovery.
  const socket = join(scope.gitDir, IPC);
  const st = optionalStat(socket);
  if (st && (!st.isSocket() || identity(st) !== base.identity)) fail('IPC changed during admission recovery');
  if (proof(base, events, socket)) {
    guard.provenIdleIdentity = base.identity;
    if (
      !events.some(
        (event) => event.phase === 'stopped' && event.nonce === base.nonce && event.identity === base.identity,
      )
    )
      append(guard, { phase: 'stopped', nonce: base.nonce, identity: base.identity });
  }
  if (st) chmodSync(socket, base.mode);
  cleanupControl(base, events);
  return guard;
}

export function recoverAdmission(entry, scope, session) {
  const path = join(scope.gitDir, `${IPC}.lock`);
  if (!optionalStat(path)) return null;
  const guard = lockedFd(path, false);
  guard.entry = entry;
  guard.scope = scope;
  session.guards.set(scope.gitDir, guard);
  return reconcile(guard, entry, scope);
}

export function acquireAdmission(entry, scope, pid, session, receipt) {
  const held = session.guards.get(scope.gitDir);
  if (held) return held;
  const nonce = randomUUID();
  const base = {
    kind: ADMISSION_KIND,
    v: 1,
    path: entry.path,
    head: entry.head,
    owner: entry.lifecycle.owner,
    identity: scope.before ? identity(scope.before) : null,
    mode: scope.before ? scope.before.mode & 0o777 : null,
    executable: scope.executable,
    monitorPid: pid,
    ...(scope.coldSocket ? { coldSocket: scope.coldSocket } : {}),
    finishPid: process.pid,
    nonce,
    controlPath: resolve(tmpdir(), `cat-cafe-fsmonitor-${nonce}`),
  };
  const rows = receipt ? receipt.receiptRecords : [base];
  if (!Array.isArray(rows) || !rows.length) fail('IPC receipt records missing');
  const pending = join(scope.gitDir, `${IPC}.${nonce}.pending`);
  const guard = lockedFd(pending, true);
  Object.assign(guard, { entry, scope, base: rows[0] });
  let published = false;
  try {
    for (const row of rows) append(guard, row);
    const canonical = join(scope.gitDir, `${IPC}.lock`);
    linkSync(pending, canonical); // Atomic exclusive publication of an already initialized, kernel-leased inode.
    guard.path = canonical;
    published = true;
    session.guards.set(scope.gitDir, guard);
    unlinkSync(pending);
    if (receipt) guard.provenIdleIdentity = guard.base.identity;
    return guard;
  } finally {
    if (!published) {
      closeSync(guard.fd);
      if (identity(optionalStat(pending) ?? {}) === guard.lockIdentity) unlinkSync(pending);
    }
  }
}

/** Receipts only attest a previous sealed, consumer-free native lifecycle at the exact owned inode/HEAD. */
export function idleReceipt(entry, scope) {
  for (const name of readdirSync(scope.gitDir)) {
    if (!/^fsmonitor--daemon\.ipc\.[a-f0-9-]{36}\.stopped$/.test(name)) continue;
    const guard = lockedFd(join(scope.gitDir, name), false);
    try {
      const [base, ...events] = records(guard);
      if (base.identity !== identity(scope.before)) continue;
      scoped(base, entry, scope);
      if (proof(base, events, join(scope.gitDir, IPC))) return { ...base, receiptRecords: [base, ...events] };
    } finally {
      closeSync(guard.fd);
    }
  }
  return null;
}

export function assertAdmission(guard) {
  if (identity(optionalStat(guard.path) ?? {}) !== guard.lockIdentity) fail('IPC admission mutex changed');
}

function closeAdmission(guard) {
  try {
    const st = optionalStat(guard.path);
    if (!st) {
      if (optionalStat(guard.entry.path)) fail('IPC admission mutex disappeared');
      return;
    }
    assertAdmission(guard);
    reconcile(guard, guard.entry, guard.scope);
    const socket = optionalStat(join(guard.scope.gitDir, IPC));
    if (socket && guard.provenIdleIdentity === identity(socket)) {
      const receipt = join(guard.scope.gitDir, `${IPC}.${guard.base.nonce}.stopped`);
      if (!optionalStat(receipt)) linkSync(guard.path, receipt);
      else if (identity(lstatSync(receipt)) !== guard.lockIdentity)
        fail('IPC receipt already exists with a different identity');
    }
    unlinkSync(guard.path);
  } finally {
    closeSync(guard.fd);
  }
}

export function closeAdmissions(session) {
  for (const guard of session.guards.values()) closeAdmission(guard);
}
