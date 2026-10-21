import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { resolveWindowsSpawnPlan } from '../../../../../../utils/cli-spawn-win.js';

export type PiRecord = Record<string, unknown>;
export const record = (value: unknown): PiRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as PiRecord) : {};
/** Official success:false is an admission rejection, not an unknown in-flight timeout. */
export class PiRpcRequestRejectedError extends Error {}

/** Pi speaks JSONL RPC, not JSON-RPC. This child is owned exclusively by one ACP session. */
export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: PiRecord) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(event: PiRecord) => void>();
  private failure?: Error;
  private ended = false;
  private closing?: Promise<void>;
  readonly exited: Promise<void>;

  constructor(command: string, args: string[], cwd: string) {
    const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(command, args) : { command, args };
    this.child = spawn(plan.command, plan.args, {
      cwd,
      stdio: 'pipe',
      windowsHide: true,
      shell: 'shell' in plan ? plan.shell : false,
      detached: process.platform !== 'win32',
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 4_000_000) {
        this.fail(new Error('Pi RPC record exceeds the supported size'));
        void this.close();
        return;
      }
      for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          this.receive(record(JSON.parse(line)));
        } catch {
          this.fail(new Error('Pi returned an invalid JSONL record'));
          void this.close();
        }
      }
    });
    const streamFailed = () => {
      this.fail(new Error('Pi RPC I/O stream closed unexpectedly'));
      void this.close();
    };
    this.child.stdin.on('error', streamFailed);
    this.child.stdout.on('error', streamFailed);
    this.child.stderr.on('error', streamFailed);
    // Drain diagnostics without forwarding secrets or parsing stderr as a wire record.
    this.child.stderr.resume();
    this.child.on('error', () => this.fail(new Error('Pi CLI could not be started')));
    this.exited = new Promise((resolve) =>
      this.child.once('close', (code, signal) => {
        this.ended = true;
        this.fail(new Error(`Pi CLI exited before completing the session (code=${code}, signal=${signal})`));
        resolve();
      }),
    );
  }

  onEvent(listener: (event: PiRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.listeners) listener({ type: '__exit', error });
  }

  private receive(event: PiRecord): void {
    if (event.type === 'extension_ui_request' && typeof event.id === 'string') {
      if (['select', 'confirm', 'input', 'editor'].includes(String(event.method)))
        this.child.stdin.write(
          `${JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true, confirmed: false })}\n`,
        );
      return;
    }
    if (event.type === 'response' && typeof event.id === 'string') {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      if (event.success === true) pending.resolve(record(event.data));
      else if (event.success === false)
        pending.reject(
          new PiRpcRequestRejectedError('Pi rejected the RPC request; check its model and login configuration'),
        );
      else pending.reject(new Error('Pi returned an invalid RPC response'));
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  async request(type: string, fields: PiRecord = {}, timeoutMs = 30_000): Promise<PiRecord> {
    if (this.failure) throw this.failure;
    const id = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Pi ${type} timed out`));
        }, timeoutMs);
        this.child.stdin.write(`${JSON.stringify({ ...fields, type, id })}\n`, (error) => {
          if (error) {
            this.pending.delete(id);
            reject(new Error('Pi input stream closed'));
          }
        });
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.closeOwned();
    return this.closing;
  }

  private async closeOwned(): Promise<void> {
    if (this.ended) return;
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.ended) return;
    const pid = this.child.pid;
    if (pid && process.platform === 'win32') {
      await new Promise<void>((resolve) =>
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()),
      );
    } else if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        this.child.kill('SIGKILL');
      }
    }
    await this.exited;
  }
}
