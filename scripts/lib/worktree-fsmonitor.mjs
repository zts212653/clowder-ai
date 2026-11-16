/** Quiesce only a proven native Git monitor belonging to an eligible owned checkout. */
import { spawnSync } from 'node:child_process';
import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gatedNativeStop } from './worktree-fsmonitor-admission.mjs';
import {
  fail,
  identity,
  mustGit,
  requireIdle,
  requireNativeIdentity,
  requireSocketScope,
  withoutPids,
} from './worktree-fsmonitor-identity.mjs';
import {
  acquireAdmission,
  assertAdmission,
  idleReceipt,
  optionalStat,
  recoverAdmission,
} from './worktree-fsmonitor-lifetime.mjs';
import { requireNoUnixConsumers } from './worktree-unix-consumers.mjs';

const IPC = 'fsmonitor--daemon.ipc';
// Darwin unp_connect checks vnode->v_socket and protocol type before listen state.
// A datagram probe detects bound non-listeners even after rename; a stream refusal cannot.
// Source: apple-oss-distributions/xnu, bsd/kern/uipc_usrreq.c#unp_connect.
// macOS system Perl exposes the syscalls without installing a package.
const SOCKET_PROBE = `
use Socket qw(AF_UNIX SOCK_DGRAM SOCK_STREAM sockaddr_un);
use Errno qw(ECONNREFUSED EPROTOTYPE);
my $binding = $ARGV[0] eq 'binding';
socket(my $s, AF_UNIX, $binding ? SOCK_DGRAM : SOCK_STREAM, 0) or exit 2;
my $connected = connect($s, sockaddr_un('fsmonitor--daemon.ipc'));
if ($binding) {
  exit 1 if $connected;
  exit 0 if $! == ECONNREFUSED;
  exit 1 if $! == EPROTOTYPE;
  exit 2;
}
exit 2 unless $connected;
# macOS sys/un.h: SOL_LOCAL=0, LOCAL_PEERPID=2. No application payload is sent.
my $peer = getsockopt($s, 0, 2);
exit 2 unless defined($peer) && length($peer) == 4;
print unpack('i', $peer);
`;
function socketStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}
function nativeCommand(path, command) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', path, 'fsmonitor--daemon', command], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) fail(`native ${command} unavailable`);
  return result.status;
}
function socketProbe(gitDir, mode) {
  if (process.platform !== 'darwin') fail('IPC binding probe unsupported');
  const result = spawnSync('/usr/bin/perl', ['-e', SOCKET_PROBE, '--', mode], {
    cwd: gitDir,
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || ![0, 1].includes(result.status) || result.stderr?.trim())
    fail('IPC binding observations unknown');
  if (mode === 'binding') return result.status === 1;
  if (result.status !== 0 || !/^[1-9]\d*$/.test(result.stdout)) fail('IPC peer identity unknown');
  return Number(result.stdout);
}
function stopNativeMonitor(entry, refs, observe, scope, session) {
  const { socket, gitDir, before, executable } = scope;
  const pid = socketProbe(gitDir, 'peer');
  requireNativeIdentity(entry, gitDir, pid, refs, executable);
  requireNoUnixConsumers(pid, refs);
  requireIdle(entry.path, gitDir, withoutPids(refs, [pid]));
  if (nativeCommand(entry.path, 'status') !== 0) fail('native monitor identity changed');
  if (identity(socketStat(socket) ?? {}) !== identity(before)) fail('IPC changed before native stop');
  gatedNativeStop(entry, scope, pid, session);
  const fresh = observe();
  if (fresh === null) fail('post-stop process state unknown');
  return fresh;
}

function prepareScope(entry, refs, session) {
  const gitDir = mustGit(entry.path, ['rev-parse', '--absolute-git-dir']);
  const socket = join(gitDir, IPC);
  let before = socketStat(socket);
  const held = session.guards.get(gitDir);
  if (held) {
    assertAdmission(held);
    if (before) fail('IPC appeared while its native startup admission was closed');
    return null;
  }
  if (!before && !optionalStat(`${socket}.lock`) && process.platform !== 'darwin') return null;
  const { executable, common } = requireSocketScope(entry, gitDir, before);
  if (before && refs.openFilesComplete !== true) fail('socket holder observations unknown');
  let scope = { socket, gitDir, before, executable, common };
  const recovered = recoverAdmission(entry, scope, session);
  before = socketStat(socket);
  if (!before) {
    acquireAdmission(entry, { ...scope, before: null }, null, session);
    if (socketStat(socket)) fail('IPC appeared while closing native startup admission');
    return null;
  }
  if (recovered?.base.identity === null) fail('IPC appeared across an absent-IPC startup lease');
  scope = { ...scope, before };
  return { ...scope, recovered };
}

function authorizeColdIpc(entry, scope, observe, session) {
  // A negative binding alone cannot recover a vanished listener's lifetime. Only a journal
  // produced by a sealed, consumer-free native lifecycle can authorize this exact inode.
  const receipt =
    scope.recovered?.provenIdleIdentity === identity(scope.before) ? scope.recovered.base : idleReceipt(entry, scope);
  if (!receipt) fail('unbound IPC lifetime unknown; retain original for owner inspection');
  acquireAdmission(entry, scope, receipt.monitorPid, session, receipt);
  const refs = observe();
  if (!refs || refs.openFilesComplete !== true) fail('cold IPC process observations unknown');
  requireIdle(entry.path, scope.gitDir, refs);
  return refs;
}

function removeIdleIpc(entry, refs, scope) {
  const { socket, gitDir, before } = scope;
  if (refs.openFilesComplete !== true) fail('socket holder observations unknown');
  requireIdle(entry.path, gitDir, refs);
  const remaining = socketStat(socket);
  if (!remaining) return refs;
  if (identity(before) !== identity(remaining) || !remaining.isSocket()) fail('IPC changed during finish');
  if (socketProbe(gitDir, 'binding') || nativeCommand(entry.path, 'status') !== 1) fail('IPC still held or listening');
  if (identity(socketStat(socket) ?? {}) !== identity(remaining)) fail('IPC changed before unlink');
  unlinkSync(socket); // Same owned inode, continuous identity from the consumer-free native stop above.
  return refs;
}

/** Called after owner/HEAD/clean/merged/durable-consumer checks, never by inventory/check. */
export function quiesceFsmonitor(entry, refs, observe, session) {
  if (refs === null) fail('process state unknown');
  const scope = prepareScope(entry, refs, session);
  if (!scope) return refs;
  const fresh = socketProbe(scope.gitDir, 'binding')
    ? stopNativeMonitor(entry, refs, observe, scope, session)
    : authorizeColdIpc(entry, scope, observe, session);
  return removeIdleIpc(entry, fresh, scope);
}
