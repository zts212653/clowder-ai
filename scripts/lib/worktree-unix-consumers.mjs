/** Darwin Unix connection identities for worktree fsmonitor cleanup. */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { identity, nativeMonitor } from './worktree-fsmonitor-identity.mjs';

const NETSTAT_COLUMNS =
  'Address Type Recv-Q Send-Q Inode Conn Refs Nextref rxbytes txbytes rhiwat shiwat process:pid state options gencnt flags flags1 usecnt rtncnt fltrs Addr';
const SO_ACCEPTCONN = 0x0002;

const fail = (message) => {
  throw new Error(`fsmonitor: ${message}; preserve live/unknown IPC consumers`);
};
const pcb = (value) => {
  if (typeof value !== 'string' || !/^(?:0x)?[0-9a-f]+$/i.test(value)) return null;
  return value.toLowerCase().replace(/^0x/, '').replace(/^0+/, '') || '0';
};

function unixConnections() {
  if (process.platform !== 'darwin') fail('Unix connection observations unsupported');
  const result = spawnSync('/usr/sbin/netstat', ['-anv', '-f', 'unix'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr?.trim())
    fail('Unix connection observations unknown');
  const lines = result.stdout.trim().split('\n');
  if (
    lines.shift() !== 'Active LOCAL (UNIX) domain sockets' ||
    lines.shift()?.trim().replaceAll(/\s+/g, ' ') !== NETSTAT_COLUMNS
  )
    fail('Unix connection format unknown');
  const rows = new Map();
  for (const line of lines) {
    // The first twelve columns have no embedded spaces. Preserve the pathname from the raw tail.
    const fixed = line.match(/^\s*(\S+)\s+(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+\S+){6}\s+(.*)$/);
    const owner = fixed?.[5].match(
      /^.*?:(?<pid>\d+)\s+(?<state>[0-9a-f]+)\s+(?<options>[0-9a-f]+)\s+(?<generation>[0-9a-f]+)(?:\s+[0-9a-f]+){5}(?:\s(?<name>.+))?$/i,
    )?.groups;
    const address = pcb(fixed?.[1]);
    const vnode = pcb(fixed?.[3]);
    const peer = pcb(fixed?.[4]);
    if (!fixed || !address || address === '0' || !vnode || !peer || !owner || rows.has(address))
      fail('Unix connection identity unknown');
    rows.set(address, {
      address,
      peer,
      pid: Number(owner.pid),
      type: fixed[2],
      bound: vnode !== '0',
      listening: (Number.parseInt(owner.options, 16) & SO_ACCEPTCONN) !== 0,
      generation: BigInt(`0x${owner.generation}`),
      name: owner.name,
    });
  }
  return rows;
}

function descriptorScope(pid, files, connections) {
  const owners = new Map();
  const target = new Set();
  for (const file of files) {
    const address = pcb(file.pcb);
    if (file.pid === pid) {
      if (!address || address === '0' || !connections.has(address)) fail('target Unix descriptor identity unknown');
      target.add(address);
    }
    if (!address) continue;
    const pids = owners.get(address) ?? new Set();
    pids.add(file.pid);
    owners.set(address, pids);
  }
  if (!target.size) fail('target Unix descriptors unknown');
  for (const row of connections.values()) if (row.pid === pid) target.add(row.address);
  return { owners, target };
}

function requireExclusiveEndpoint(allowed, row, connections, owners) {
  if (!allowed.has(row.pid) || [...(owners.get(row.address) ?? [])].some((owner) => !allowed.has(owner)))
    fail('active Unix IPC consumer');
  if (row.peer === '0') return;
  const peer = connections.get(row.peer);
  const peerOwners = owners.get(row.peer);
  if (!peer || peer.peer !== row.address || !peerOwners?.size) fail('Unix peer identity unknown');
  if (!allowed.has(peer.pid) || [...peerOwners].some((owner) => !allowed.has(owner))) fail('active Unix IPC consumer');
}

/** Include queued connections (kernel PID, no accepted FD yet) and every FD owner. Never infer scope from names. */
export function requireNoUnixConsumers(pid, refs, { controlPid } = {}) {
  if (refs.openFilesComplete !== true || !Array.isArray(refs.unixFiles)) fail('Unix descriptor observations unknown');
  const connections = unixConnections();
  const { owners, target } = descriptorScope(pid, refs.unixFiles, connections);
  const allowed = new Set([pid]);
  if (Number.isInteger(controlPid) && controlPid > 0) allowed.add(controlPid);
  for (const row of connections.values()) {
    if (!target.has(row.address) && !target.has(row.peer)) continue;
    requireExclusiveEndpoint(allowed, row, connections, owners);
  }
}

function underneath(path, dir) {
  return path === dir || path.startsWith(`${dir}/`);
}

function darwinAddressPath(address) {
  const systemAlias = address.match(/^\/(?:tmp|var)(?=\/)/)?.[0];
  if (!systemAlias) return address;
  const stat = lstatSync(systemAlias);
  return stat.isSymbolicLink() && stat.uid === 0 ? `/private${address}` : address;
}

function renameableByOwner(parent, entry, owner) {
  const directory = lstatSync(parent, { bigint: true });
  if (directory.uid === owner) return true;
  if ((directory.mode & 0o1000n) !== 0n && entry.uid !== owner) return false;
  try {
    accessSync(parent, constants.W_OK | constants.X_OK);
    return true;
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS') return false;
    throw error;
  }
}

function externalPathPredatesSocket(path, socket) {
  // Renaming an ancestor can restore the old literal address without touching
  // the listener's inode or its immediate parent.
  for (let dir = dirname(path); dir !== '/'; dir = dirname(dir)) {
    const entry = lstatSync(dir, { bigint: true });
    if (!entry.isDirectory()) return false;
    if (entry.ctimeNs >= socket.birthtimeNs && renameableByOwner(dirname(dir), entry, socket.uid)) return false;
  }
  return true;
}

function confirmedForeignAddress(address, entry, scope, sameProcess) {
  // An absolute alias of the native name can be rebound without moving its inode.
  if (!isAbsolute(address) || basename(address).toLowerCase() === basename(scope.socket)) return false;
  try {
    if (resolve(address) !== address) return false;
    const path = realpathSync.native(address);
    // Compare the entire address, including the final component. Only the
    // standard root-owned Darwin aliases may differ from the physical path.
    if (path !== darwinAddressPath(address)) return false;
    if ([address, path].some((value) => underneath(value, entry.path) || underneath(value, scope.common))) return false;
    const file = lstatSync(path, { bigint: true });
    // A replacement at the same name can have an earlier socket generation
    // than the accepted FD. The current binding and movable pathname entries
    // must also predate the target socket.
    return (
      file.isSocket() &&
      identity(file) !== identity(scope.before) &&
      file.ctimeNs < scope.before.birthtimeNs &&
      (file.uid !== scope.before.uid || sameProcess) &&
      externalPathPredatesSocket(path, scope.before)
    );
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function independentListener(row, listeners, entry, scope, refs) {
  const earlier = listeners.filter((listener) => listener.generation < row.generation);
  if (!earlier.length) return false;
  // A native Git daemon owns a single listener. requireIdle already excluded a daemon holding this checkout.
  const sameProcess = earlier.some((listener) => listener.pid === row.pid);
  if (sameProcess && nativeMonitor(row.pid, refs, scope.executable)) return true;
  return confirmedForeignAddress(row.name, entry, scope, sameProcess);
}

/** Accepted stream endpoints retain the original bind name even after their listener closes or is renamed. */
export function requireNoDetachedUnixConsumers(entry, scope, refs) {
  const named = [...unixConnections().values()].filter((row) => row.type === 'stream' && row.name);
  const listeners = new Map();
  for (const row of named) {
    if (!row.bound || !row.listening) continue;
    const group = listeners.get(row.name) ?? [];
    group.push(row);
    listeners.set(row.name, group);
  }
  for (const row of named) {
    if (!row.bound && !independentListener(row, listeners.get(row.name) ?? [], entry, scope, refs))
      fail(`detached Unix IPC endpoint with unresolved checkout scope pid=${row.pid}`);
  }
}
