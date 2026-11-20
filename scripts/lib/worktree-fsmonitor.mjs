/** Quiesce only a proven native Git monitor belonging to an eligible owned checkout. */
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
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
import { requireNoDetachedUnixConsumers, requireNoUnixConsumers } from './worktree-unix-consumers.mjs';

const IPC = 'fsmonitor--daemon.ipc';
// Darwin unp_connect checks vnode->v_socket and protocol type before listen state.
// A datagram probe detects bound non-listeners even after rename; a stream refusal cannot.
// Source: apple-oss-distributions/xnu, bsd/kern/uipc_usrreq.c#unp_connect.
// macOS system Perl exposes the syscalls without installing a package.
const SOCKET_PROBE = `
use Socket qw(AF_UNIX SOCK_DGRAM SOCK_STREAM sockaddr_un);
use Errno qw(ECONNREFUSED EPROTOTYPE);
sub attributes {
  my ($path, $common, $volume) = @_;
  # Darwin getattrlist with ATTR_CMN_RETURNED_ATTRS and FSOPT_NOFOLLOW.
  my $attrs = pack('S S L5', 5, 0, $common, $volume, 0, 0, 0);
  my $result = chr(0) x 64;
  syscall(220, $path, $attrs, $result, length($result), 1) == 0 or exit 2;
  my ($length, $returned_common, $returned_volume) = unpack('L3', $result);
  exit 2 unless $length >= 24 && $length <= length($result)
    && $returned_common == $common && $returned_volume == ($volume & 0x7fffffff);
  return substr($result, 24, $length - 24);
}
sub placement_times {
  use integer;
  my ($path) = @_;
  my $times = attributes($path, 0x90000200, 0); # Creation and Date Added.
  exit 2 unless length($times) == 32;
  my ($birth_sec, $birth_ns, $added_sec, $added_ns) = unpack('q4', $times);
  exit 2 unless $birth_sec > 0 && $added_sec > 0;
  return ($birth_sec * 1_000_000_000 + $birth_ns, $added_sec * 1_000_000_000 + $added_ns);
}
my $binding = $ARGV[0] ne 'peer';
socket(my $s, AF_UNIX, $binding ? SOCK_DGRAM : SOCK_STREAM, 0) or exit 2;
my $connected = connect($s, sockaddr_un('fsmonitor--daemon.ipc'));
if ($binding) {
  exit 1 if $connected;
  exit 1 if $! == EPROTOTYPE;
  exit 2 unless $! == ECONNREFUSED;
  if ($ARGV[0] eq 'cold') {
    my $fs = attributes('.', 0x80000000, 0x80100000); # File system type name.
    exit 2 unless length($fs) >= 13;
    my ($offset, $length) = unpack('l L', $fs);
    exit 2 unless $offset >= 8 && $offset + $length <= length($fs) && substr($fs, $offset, $length) eq 'apfs'.chr(0);
    my ($born, $added) = placement_times('fsmonitor--daemon.ipc');
    my (undef, $parent_added) = placement_times('.');
    # An absolute bind address outside this Git directory cannot be treated as independent
    # if the socket or its containing directory moved here after the bind.
    exit 3 if $born != $added || $parent_added > $born;
  }
  exit 0;
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
  if (result.error || result.signal || result.stderr?.trim()) fail('IPC binding observations unknown');
  if (mode === 'cold' && result.status === 3) fail('cold IPC placement changed; preserve possible Unix IPC consumers');
  if (![0, 1].includes(result.status)) fail('IPC binding observations unknown');
  if (mode !== 'peer') return result.status === 1;
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
    if (held.base.coldSocket) return { ...held.scope, before, coldGuard: held };
    if (before) fail('IPC appeared while its native startup admission was closed');
    return null;
  }
  if (!before && !optionalStat(`${socket}.lock`) && process.platform !== 'darwin') return null;
  const { executable, common } = requireSocketScope(entry, gitDir, before);
  if (before && refs.openFilesComplete !== true) fail('socket holder observations unknown');
  let scope = { socket, gitDir, before, executable, common };
  const recovered = recoverAdmission(entry, scope, session);
  before = socketStat(socket);
  if (recovered?.base.coldSocket) return { ...scope, before, coldGuard: recovered };
  if (!before) {
    acquireAdmission(entry, { ...scope, before: null }, null, session);
    if (socketStat(socket)) fail('IPC appeared while closing native startup admission');
    return null;
  }
  if (recovered?.base.identity === null) fail('IPC appeared across an absent-IPC startup lease');
  scope = { ...scope, before };
  return { ...scope, recovered };
}

function coldSocketStamp(st) {
  return st?.isSocket() && st.nlink === 1n ? `${identity(st)}:${st.birthtimeNs}:${st.ctimeNs}:${st.mode}` : null;
}

function coldGitLink(entry, scope, socket) {
  const link = join(entry.path, '.git');
  const stat = optionalStat(link, true);
  // Changing the Git directory's name requires rewriting this pointer, even
  // when APFS preserves Date Added for that directory and its socket.
  if (
    !stat?.isFile() ||
    stat.ctimeNs >= socket.birthtimeNs ||
    readFileSync(link, 'utf8') !== `gitdir: ${scope.gitDir}\n`
  )
    fail('cold IPC placement changed or checkout link unknown; preserve possible Unix IPC consumers');
  return `${identity(stat)}:${stat.ctimeNs}`;
}

function verifyColdIpc(entry, scope, refs, guard, session) {
  if (!refs || refs.openFilesComplete !== true) fail('cold IPC process observations unknown');
  requireIdle(entry.path, scope.gitDir, refs);
  const socket = optionalStat(scope.socket, true);
  if (!scope.before || coldSocketStamp(socket) !== guard.base.coldSocket) fail('cold IPC changed or is still bound');
  const link = coldGitLink(entry, scope, socket);
  if (socketProbe(scope.gitDir, 'cold')) fail('cold IPC changed or is still bound');
  requireNoDetachedUnixConsumers(entry, { ...scope, before: socket }, refs);
  assertAdmission(guard);
  if (
    coldSocketStamp(optionalStat(scope.socket, true)) !== guard.base.coldSocket ||
    coldGitLink(entry, scope, socket) !== link
  )
    fail('cold IPC or checkout link changed during inspection');
  session.coldSocketPath = scope.socket;
  return refs;
}

function authorizeColdIpc(entry, scope, observe, session) {
  const receipt =
    scope.recovered?.provenIdleIdentity === identity(scope.before) ? scope.recovered.base : idleReceipt(entry, scope);
  if (receipt) {
    acquireAdmission(entry, scope, receipt.monitorPid, session, receipt);
    return removeIdleIpc(entry, observe(), scope);
  }
  const st = optionalStat(scope.socket, true);
  const coldSocket = coldSocketStamp(st);
  if (!coldSocket || identity(st) !== identity(scope.before)) fail('cold IPC inode or links changed');
  // Keep the exact socket until Git removes its private metadata after a verified archive.
  const guard = acquireAdmission(entry, { ...scope, before: null, coldSocket }, null, session);
  return verifyColdIpc(entry, scope, observe(), guard, session);
}

function removeIdleIpc(entry, refs, scope) {
  const { socket, gitDir, before } = scope;
  if (refs?.openFilesComplete !== true) fail('socket holder observations unknown');
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
  if (scope.coldGuard) return verifyColdIpc(entry, scope, refs, scope.coldGuard, session);
  if (socketProbe(scope.gitDir, 'binding'))
    return removeIdleIpc(entry, stopNativeMonitor(entry, refs, observe, scope, session), scope);
  return authorizeColdIpc(entry, scope, observe, session);
}
