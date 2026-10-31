import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import WebSocket from 'ws';

export const waitUntil = async (predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('f320_fixture_timeout');
};
export async function startLayoutHost(binary, home, state, root, name, configArgs = []) {
  const socketPath = `${root}/${name}.sock`;
  const child = spawn(binary, ['app-server', '--listen', `unix://${socketPath}`, ...configArgs], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: state,
      RUST_LOG: 'error',
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      ALL_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-8192);
  });
  let wire;
  const stop = async () => {
    wire?.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit');
    child.kill('SIGTERM');
    const escalation = setTimeout(() => child.kill('SIGKILL'), 2000);
    try {
      await ended;
    } finally {
      clearTimeout(escalation);
    }
  };
  try {
    await waitUntil(() => {
      if (child.exitCode !== null) throw new Error(`isolated native host exited: ${stderr}`);
      return existsSync(socketPath);
    });
    const socket = connect(socketPath);
    await once(socket, 'connect');
    wire = new WebSocket('ws://localhost', { createConnection: () => socket });
    await once(wire, 'open');
    const waiting = new Map();
    const events = [];
    let sequence = 0;
    wire.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      events.push(message);
      waiting.get(message.id)?.(message);
    });
    const rpc = async (method, params) => {
      const id = ++sequence;
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }, 12000);
        waiting.set(id, (message) => {
          clearTimeout(timeout);
          waiting.delete(id);
          resolve(message);
        });
      });
      wire.send(JSON.stringify({ id, method, params }));
      const message = await response;
      if (message.error) throw new Error(`${method}: ${message.error.message.slice(0, 300)}`);
      return message.result;
    };
    await rpc('initialize', {
      clientInfo: { name: `f320_layout_${name}`, version: '1' },
      capabilities: { experimentalApi: true },
    });
    wire.send(JSON.stringify({ method: 'initialized' }));
    return { rpc, events, stop, socketPath, diagnostic: () => stderr };
  } catch (error) {
    await stop();
    throw error;
  }
}
