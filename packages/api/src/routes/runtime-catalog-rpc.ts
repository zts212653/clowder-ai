import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { record } from './runtime-model-catalog.js';

/** Bounded discovery connection. No prompts, terminal/file access, or approvals. */
export function catalogRpc(command: string, args: string[], cwd: string, timeoutMs = 20_000) {
  const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(command, args) : { command, args };
  const child = spawn(plan.command, plan.args, {
    cwd,
    env: buildChildEnv(undefined, { workingDirectory: cwd }),
    shell: 'shell' in plan ? plan.shell : false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const input = createInterface({ input: child.stdout });
  let sequence = 0;
  let size = 0;
  let ended = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = () => {
    ended = true;
    for (const p of pending.values()) p.reject(new Error('catalog_unavailable'));
    pending.clear();
  };
  const write = (value: unknown) => {
    if (!ended) child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  child.once('error', fail);
  child.once('exit', fail);
  child.stdin.on('error', fail);
  child.stderr.resume(); // Provider output can contain private configuration; never return or log it.
  const deadline = setTimeout(() => {
    fail();
    void close();
  }, timeoutMs);
  child.stdout.on('data', (chunk) => {
    size += Buffer.byteLength(chunk);
    if (size > 4_000_000) {
      fail();
      void close();
      return;
    }
  });
  input.on('line', (line) => {
    let envelope: Record<string, unknown>;
    try {
      envelope = record(JSON.parse(line));
    } catch {
      return;
    }
    if (envelope.method && envelope.id !== undefined) {
      write({
        jsonrpc: '2.0',
        id: envelope.id,
        error: { code: -32601, message: 'Discovery does not execute agent requests' },
      });
      return;
    }
    const p = pending.get(Number(envelope.id));
    if (!p) return;
    pending.delete(Number(envelope.id));
    if (envelope.error) p.reject(new Error('catalog_unavailable'));
    else p.resolve(envelope.result);
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    clearTimeout(deadline);
    input.close();
    fail();
    closing = new Promise((resolve) => {
      if (!child.pid || child.exitCode !== null) {
        resolve();
        return;
      }
      if (process.platform === 'win32') {
        const killer = spawn(
          join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.once('error', () => {
          child.kill();
          resolve();
        });
        killer.once('exit', () => resolve());
      } else {
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 1000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      }
    });
    return closing;
  }
  return {
    close,
    notify: (method: string) => write({ jsonrpc: '2.0', method }),
    request: (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (ended) return Promise.reject(new Error('catalog_unavailable'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
  };
}
