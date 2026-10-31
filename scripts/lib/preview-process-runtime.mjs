import { spawnSync } from 'node:child_process';
import net from 'node:net';

export function processGroupExists(record) {
  if (process.platform === 'win32') {
    try {
      process.kill(record.pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }
  const processes = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
  if (processes.status === 0) {
    return processes.stdout.split('\n').some((line) => {
      const [processGroupId, state] = line.trim().split(/\s+/, 2);
      return Number(processGroupId) === record.pid && state && !state.startsWith('Z');
    });
  }
  try {
    process.kill(-record.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function probePort(port, timeoutMs = 250) {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (reachable) => {
      socket.destroy();
      resolveProbe(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function waitForPort(port, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await probePort(port)) === expected) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  } while (Date.now() < deadline);
  return false;
}

export async function waitForProcessGroupExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processGroupExists(record)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  } while (Date.now() < deadline);
  return !processGroupExists(record);
}
