import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import WebSocket from 'ws';
import { MCP_CALLBACK_ENV_KEYS } from '../../../../../config/capabilities/mcp-constants.js';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import type { AgentCarrierSession, AgentCarrierSessionOptions } from '../../types.js';

const SOCKET_READY_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 1_500;
const SESSION_SCOPED_ENV_KEYS = new Set<string>([...MCP_CALLBACK_ENV_KEYS, 'CAT_CAFE_CREDENTIAL_FILE']);

export interface CodexAppServerHostLaunch {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string | null>;
  socketDirectory: string;
  socketPath: string;
}

export interface CodexAppServerHostProcess {
  readonly isAlive: boolean;
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface PreparedCodexHostLaunch {
  signature: string;
  launch: Omit<CodexAppServerHostLaunch, 'socketDirectory' | 'socketPath'>;
}

export function prepareCodexHostLaunch(options: AgentCarrierSessionOptions): PreparedCodexHostLaunch {
  const signatureEnv = Object.fromEntries(
    Object.entries(options.env ?? {}).filter(([key]) => !SESSION_SCOPED_ENV_KEYS.has(key)),
  );
  const env: Record<string, string | null> = { ...signatureEnv };
  // Missing keys would be inherited again by normalizeEnv(). Explicit nulls
  // remove invocation identity from the long-lived child process.
  for (const key of SESSION_SCOPED_ENV_KEYS) env[key] = null;
  const args = withoutTransportArgs(options.args);
  const signaturePayload = {
    command: options.command,
    args,
    cwd: options.cwd ?? null,
    env: Object.entries(signatureEnv).sort(([left], [right]) => left.localeCompare(right)),
  };
  return {
    signature: createHash('sha256').update(JSON.stringify(signaturePayload)).digest('hex'),
    launch: {
      command: options.command,
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env,
    },
  };
}

function withoutTransportArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--stdio') continue;
    if (value === '--listen') {
      index++;
      continue;
    }
    result.push(value);
  }
  return result;
}

export function withUnixListener(args: readonly string[], socketPath: string): string[] {
  if (args[0] !== 'app-server') throw new Error('Codex host pooling requires app-server arguments');
  return ['app-server', '--listen', `unix://${socketPath}`, ...args.slice(1)];
}

class AsyncMessageQueue implements AsyncIterable<unknown> {
  private readonly values: unknown[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<unknown>): void;
    reject(error: Error): void;
  }> = [];
  private ended = false;
  private failure: Error | null = null;

  push(value: unknown): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error ?? null;
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

class CodexUnixWebSocketSession implements AgentCarrierSession {
  private readonly inbox = new AsyncMessageQueue();
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      try {
        this.inbox.push(JSON.parse(data.toString()));
      } catch (error) {
        this.inbox.end(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', (error) => this.inbox.end(error));
    socket.once('close', () => this.inbox.end());
  }

  read(): AsyncIterable<unknown> {
    return this.inbox;
  }

  async write(message: Record<string, unknown>): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is closed');
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = waitForWebSocketClose(this.socket, CLOSE_GRACE_MS);
    this.socket.close();
    if (!(await closed)) this.socket.terminate();
  }

  async terminate(): Promise<void> {
    this.closed = true;
    this.socket.terminate();
  }
}

class SpawnedCodexAppServerHost implements CodexAppServerHostProcess {
  constructor(
    private readonly child: ChildProcess,
    readonly socketPath: string,
    private readonly stderr: string[],
  ) {}

  get isAlive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  async close(): Promise<void> {
    if (!this.isAlive) return;
    const exited = waitForChildExit(this.child, CLOSE_GRACE_MS);
    this.child.kill('SIGTERM');
    const didExit = await exited;
    if (!didExit && this.isAlive) {
      const killed = once(this.child, 'exit');
      this.child.kill('SIGKILL');
      await killed;
    }
  }

  diagnostic(): string {
    return sanitizeCliStderr(this.stderr.join('').slice(-1_000));
  }
}

function normalizeEnv(input?: Record<string, string | null>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function createCodexSocketDirectory(): string {
  if (process.platform === 'win32') throw new Error('Codex unix-socket host pooling is unavailable on Windows');
  const realTmp = realpathSync('/tmp');
  return mkdtempSync(join(realTmp, 'cat-cafe-codex-host-'));
}

export async function removeCodexSocketDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function spawnCodexAppServerHost(launch: CodexAppServerHostLaunch): Promise<CodexAppServerHostProcess> {
  const stderr: string[] = [];
  const child = spawn(launch.command, [...launch.args], {
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    env: normalizeEnv(launch.env),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.join('').length < 8_192) stderr.push(chunk);
  });
  const spawnState: { error?: Error } = {};
  child.once('error', (error) => {
    spawnState.error = error;
  });
  const host = new SpawnedCodexAppServerHost(child, launch.socketPath, stderr);
  const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
  while (!existsSync(launch.socketPath) && host.isAlive && !spawnState.error && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (existsSync(launch.socketPath) && host.isAlive) return host;
  await host.close().catch(() => {});
  const detail = spawnState.error ? sanitizeCliStderr(spawnState.error.message) : host.diagnostic();
  throw new Error(`Codex app-server unix socket did not become ready${detail ? `: ${detail}` : ''}`);
}

export async function connectCodexAppServerHost(host: CodexAppServerHostProcess): Promise<AgentCarrierSession> {
  const socket = new WebSocket('ws://localhost/', {
    handshakeTimeout: 3_000,
    perMessageDeflate: false,
    createConnection: () => connect({ path: host.socketPath }),
  });
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  return new CodexUnixWebSocketSession(socket);
}

function waitForWebSocketClose(socket: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    socket.once('close', onClose);
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
