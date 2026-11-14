import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { delimiter, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { closeCatalogProcess } from '../../routes/runtime-catalog-process.js';
import { resolveWindowsSpawnPlan } from '../../utils/cli-spawn-win.js';

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
  return [dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter);
}

/** System runtime fields only; private probes never inherit user authentication or endpoint overrides. */
export function probeEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'PROGRAMDATA']
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
    PATH: probePath(),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost',
  };
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
  const windows = process.platform === 'win32';
  const args = [
    'app-server',
    '--listen',
    windows ? 'stdio://' : `unix://${input.socketPath}`,
    ...(input.configArgs ?? []),
  ];
  const plan = windows ? resolveWindowsSpawnPlan(binary, args) : { command: binary, args };
  const child = spawn(plan.command, plan.args, {
    cwd: input.cwd,
    env: {
      ...probeEnvironment(input.home),
      CODEX_SQLITE_HOME: input.sqliteHome,
      RUST_LOG: 'error',
    },
    shell: 'shell' in plan ? plan.shell : false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr = (stderr + data).slice(-4096);
  });
  let wire: WebSocket | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let launchError: Error | undefined;
  child.once('error', (error) => {
    launchError = error;
  });
  child.stdin.on('error', () => {});
  const stop = async () => {
    lines?.close();
    wire?.close();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (windows) {
      // EOF lets the native host release its single-writer lock before the next home resumes it.
      const ended = once(child, 'exit');
      child.stdin.end();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ended,
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 2000);
        }),
      ]);
      if (deadline) clearTimeout(deadline);
      await closeCatalogProcess(child, input.socketPath);
      await ended;
      return;
    }
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
    let send: (value: Record<string, unknown>) => void;
    let onMessage: (receive: (bytes: string) => void) => void;
    if (windows) {
      lines = createInterface({ input: child.stdout });
      send = (value) => {
        child.stdin.write(`${JSON.stringify(value)}\n`);
      };
      onMessage = (receive) => {
        lines?.on('line', receive);
      };
    } else {
      await waitUntil(() => {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error(`codex_probe_host_exited:${stderr.slice(-300)}`);
        return existsSync(input.socketPath);
      });
      const socket = connect(input.socketPath);
      await once(socket, 'connect');
      const opened = new WebSocket('ws://localhost', { createConnection: () => socket });
      wire = opened;
      await once(opened, 'open');
      send = (value) => {
        opened.send(JSON.stringify(value));
      };
      onMessage = (receive) => {
        opened.on('message', (bytes) => receive(bytes.toString()));
      };
    }
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    const events: ProbeEvent[] = [];
    let sequence = 0;
    onMessage((bytes) => {
      const message = JSON.parse(bytes) as Record<string, unknown>;
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
        if (launchError) {
          reject(launchError);
          clearTimeout(timeout);
          waiting.delete(id);
          return;
        }
        send({ id, method, params });
      });
      const error = message.error as { message?: string } | undefined;
      if (error) throw new Error(`${method}: ${String(error.message ?? 'error').slice(0, 300)}`);
      return (message.result ?? {}) as Record<string, unknown>;
    };
    await rpc('initialize', {
      clientInfo: { name: `cat_cafe_compat_${input.name}`, version: '1' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized' });
    return { rpc, events, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
