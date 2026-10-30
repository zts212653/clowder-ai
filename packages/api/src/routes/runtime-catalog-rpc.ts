import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { CLI_PROCESS_OWNER_ENV } from '../utils/cli-process-environment.js';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { closeCatalogProcess } from './runtime-catalog-process.js';
import { record } from './runtime-model-catalog.js';

/** Bounded discovery connection. No prompts, terminal/file access, or approvals. */
export function catalogRpc(command: string, args: string[], cwd: string, timeoutMs = 20_000) {
  const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(command, args) : { command, args };
  const ownerId = randomUUID();
  const child = spawn(plan.command, plan.args, {
    cwd,
    env: {
      ...buildChildEnv(undefined, { workingDirectory: cwd }),
      ...('env' in plan ? plan.env : {}),
      [CLI_PROCESS_OWNER_ENV]: ownerId,
    },
    detached: process.platform !== 'win32',
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
  const failAndClose = () => {
    fail();
    // Explicit callers can observe cleanup failure; event handlers must not create unhandled rejections.
    void close().catch(() => {});
  };
  child.once('error', failAndClose);
  child.once('exit', failAndClose);
  child.stdin.on('error', failAndClose);
  child.stderr.resume(); // Provider output can contain private configuration; never return or log it.
  const deadline = setTimeout(failAndClose, timeoutMs);
  child.stdout.on('data', (chunk) => {
    size += Buffer.byteLength(chunk);
    if (size > 4_000_000) {
      failAndClose();
      return;
    }
  });
  input.on('line', (line) => {
    let envelope: Record<string, unknown>;
    try {
      envelope = record(JSON.parse(line));
    } catch {
      failAndClose();
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
    if (envelope.error) {
      p.reject(new Error('catalog_unavailable'));
      failAndClose();
    } else p.resolve(envelope.result);
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    clearTimeout(deadline);
    input.close();
    fail();
    closing = closeCatalogProcess(child, ownerId).finally(() => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
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
