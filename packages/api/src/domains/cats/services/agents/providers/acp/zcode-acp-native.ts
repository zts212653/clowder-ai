import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  ensureZcodeIsolatedHome,
  type JsonRpc,
  resolveZcodeIsolatedHome,
  ZcodeStderrRedactor,
  zcodeAppServerEnv,
  zcodeLaunchPlan,
} from './zcode-acp-protocol.js';

type PendingWaiter = {
  resolve: (msg: JsonRpc) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Private ZCode 0.16.3 app-server client. Frames never include `jsonrpc`. */
export class NativeAppServer {
  private child: ChildProcess;
  private pending = new Map<string, PendingWaiter>();
  private nextId = 1;
  private listeners: Array<(msg: JsonRpc) => void> = [];
  private closeListeners: Array<(reason: string) => void> = [];
  private closedReason: string | undefined;
  private stderr = new ZcodeStderrRedactor();
  readonly isolatedHome: string;

  constructor(bin: string, env: NodeJS.ProcessEnv = process.env) {
    const plan = zcodeLaunchPlan(bin);
    this.isolatedHome = ensureZcodeIsolatedHome(resolveZcodeIsolatedHome(env));
    this.child = spawn(plan.command, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: zcodeAppServerEnv(env, this.isolatedHome),
    });
    if (!this.child.stdout || !this.child.stdin) {
      throw new Error('zcode app-server spawn missing stdio pipes');
    }
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.child.stderr?.on('data', (buf) => {
      for (const line of this.stderr.push(buf.toString())) {
        process.stderr.write(`[zcode-app-server] ${line}\n`);
      }
    });
    this.child.on('error', (err) => {
      this.fail(`zcode app-server error: ${err instanceof Error ? err.message : 'spawn failed'}`);
    });
    this.child.on('exit', (code, signal) => {
      this.flushStderr();
      this.fail(`zcode app-server exited code=${code} signal=${signal}`);
    });
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  onEvent(listener: (msg: JsonRpc) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason) {
      queueMicrotask(() => listener(this.closedReason as string));
      return () => {};
    }
    this.closeListeners.push(listener);
    return () => {
      const index = this.closeListeners.indexOf(listener);
      if (index >= 0) this.closeListeners.splice(index, 1);
    };
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<JsonRpc> {
    if (this.closedReason) {
      return Promise.resolve({ error: { code: -32000, message: this.closedReason } });
    }
    const id = this.nextId++;
    this.writeNative({ id, method, params });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        resolve({ error: { code: -32000, message: `timeout waiting for ${method}` } });
      }, timeoutMs);
      this.pending.set(String(id), { resolve, timer });
    });
  }

  reply(id: number | string, result: unknown): void {
    this.writeNative({ id, result });
  }

  close(): void {
    this.fail('zcode app-server closed');
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    this.child.kill('SIGTERM');
  }

  whenExited(): Promise<void> {
    if (this.child.exitCode != null || this.child.signalCode) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
    });
  }

  private fail(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    const err: JsonRpc = { error: { code: -32000, message: reason } };
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(err);
    }
    this.pending.clear();
    const listeners = [...this.closeListeners];
    this.closeListeners = [];
    for (const listener of listeners) listener(reason);
  }

  private flushStderr(): void {
    const leftover = this.stderr.flush();
    if (leftover) process.stderr.write(`[zcode-app-server] ${leftover}\n`);
  }

  private writeNative(payload: JsonRpc): void {
    if (this.closedReason) return;
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(trimmed) as JsonRpc;
    } catch {
      return;
    }
    if (msg.method === 'session/requestRuntimePreferences' && msg.id != null) {
      this.reply(msg.id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      });
      return;
    }
    if (msg.method === 'interaction/requestPermission' && msg.id != null) {
      this.reply(msg.id, { decision: 'allow', reason: 'Hub yolo mode' });
      return;
    }
    if (msg.method && msg.id != null) {
      this.writeNative({ id: msg.id, error: { code: -32601, message: `unhandled ${msg.method}` } });
      return;
    }
    if (msg.id != null && this.pending.has(String(msg.id))) {
      const waiter = this.pending.get(String(msg.id));
      this.pending.delete(String(msg.id));
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
      return;
    }
    for (const listener of this.listeners) listener(msg);
  }
}
