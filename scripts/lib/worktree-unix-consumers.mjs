/** Darwin Unix connection identities, scoped by a previously proven native Git PID. */
import { spawnSync } from 'node:child_process';

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
    !/^Address\s+Type\s+Recv-Q\s+Send-Q\s+Inode\s+Conn\s+Refs\s+Nextref\s+rxbytes\s+txbytes\s+rhiwat\s+shiwat\s+process:pid\s/.test(
      lines.shift() ?? '',
    )
  )
    fail('Unix connection format unknown');
  const rows = new Map();
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    // These first twelve columns are numeric except for the socket type. Names may contain spaces.
    const owner = fields
      .slice(12)
      .join(' ')
      .match(/^.*?:(\d+)\s+[0-9a-f]+\s+[0-9a-f]+\s/i);
    const address = pcb(fields[0]);
    const peer = pcb(fields[5]);
    if (!address || address === '0' || !peer || !owner || rows.has(address)) fail('Unix connection identity unknown');
    rows.set(address, { address, peer, pid: Number(owner[1]) });
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
