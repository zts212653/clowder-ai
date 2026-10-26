import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import WebSocket from 'ws';

// Probe-only native hosts: temporary homes, an unauthenticated loopback model, and blocked egress.
// Never point these at a real CODEX_HOME, Keychain, daemon or the runtime's sockets.

export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('codex_probe_timeout');
}

export interface ProbeModelRequest {
  authorization: boolean;
  nativeMemory: boolean;
}
export interface ProbeModel {
  url: string;
  requests: ProbeModelRequest[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export async function startProbeModel(memoryMarker: string): Promise<ProbeModel> {
  const requests: ProbeModelRequest[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.method !== 'POST') {
      res.writeHead(200);
      res.end('{"data":[]}');
      return;
    }
    const body = JSON.parse(raw) as { model?: string };
    requests.push({ authorization: Boolean(req.headers.authorization), nativeMemory: raw.includes(memoryMarker) });
    const id = `probe-${requests.length}`;
    const item = {
      type: 'message',
      id: `msg-${id}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: `PROBE_REPLY_${requests.length}` }],
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
    for (const [type, payload] of [
      ['response.created', { response: { id, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response: { id, status: 'completed', model: body.model, output: [item], usage } }],
    ] as const)
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('codex_probe_model_unavailable');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface ProbeEvent {
  method?: string;
  params?: Record<string, unknown>;
}
export interface ProbeHost {
  rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  events: ProbeEvent[];
  stop(): Promise<void>;
}

/** PATH keeps the Node that runs this API first: the npm `codex` wrapper is `#!/usr/bin/env node`. */
export function probePath(): string {
  return [dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(':');
}

export async function startProbeHost(
  binary: string,
  input: {
    home: string;
    sqliteHome: string;
    cwd: string;
    socketPath: string;
    name: string;
    configArgs?: readonly string[];
  },
): Promise<ProbeHost> {
  const args = ['app-server', '--listen', `unix://${input.socketPath}`, ...(input.configArgs ?? [])];
  const child: ChildProcess = spawn(binary, args, {
    cwd: input.cwd,
    env: {
      PATH: probePath(),
      HOME: input.home,
      CODEX_HOME: input.home,
      CODEX_SQLITE_HOME: input.sqliteHome,
      RUST_LOG: 'error',
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      ALL_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr = (stderr + data).slice(-4096);
  });
  let wire: WebSocket | undefined;
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
      if (child.exitCode !== null) throw new Error(`codex_probe_host_exited:${stderr.slice(-300)}`);
      return existsSync(input.socketPath);
    });
    const socket = connect(input.socketPath);
    await once(socket, 'connect');
    const opened = new WebSocket('ws://localhost', { createConnection: () => socket });
    wire = opened;
    await once(opened, 'open');
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    const events: ProbeEvent[] = [];
    let sequence = 0;
    opened.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString()) as Record<string, unknown>;
      events.push(message as ProbeEvent);
      if (typeof message.id === 'number') waiting.get(message.id)?.(message);
    });
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const id = ++sequence;
      const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`codex_probe_rpc_timeout:${method}`));
        }, 15_000);
        waiting.set(id, (reply) => {
          clearTimeout(timeout);
          waiting.delete(id);
          resolve(reply);
        });
        opened.send(JSON.stringify({ id, method, params }));
      });
      const error = message.error as { message?: string } | undefined;
      if (error) throw new Error(`${method}: ${String(error.message ?? 'error').slice(0, 300)}`);
      return (message.result ?? {}) as Record<string, unknown>;
    };
    await rpc('initialize', {
      clientInfo: { name: `cat_cafe_compat_${input.name}`, version: '1' },
      capabilities: { experimentalApi: true },
    });
    opened.send(JSON.stringify({ method: 'initialized' }));
    return { rpc, events, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
