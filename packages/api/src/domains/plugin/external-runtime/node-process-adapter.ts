import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { platform } from 'node:os';
import process from 'node:process';
import type {
  ExternalPluginProcess,
  ExternalPluginProcessAdapter,
  ExternalPluginProcessExit,
  ExternalPluginProcessSpec,
} from './types.js';
import { ExternalPluginRuntimeError } from './types.js';

const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_DIAGNOSTIC_LINE_BYTES = 512;
const RUNTIME_DIAGNOSTIC_CODES = new Set([
  'AUTH_EXPIRED',
  'EVENT_BUS_CONFLICT',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'UNEXPECTED_RUNTIME_FAILURE',
]);

function parseRuntimeDiagnostic(line: Buffer): ExternalPluginProcessExit['diagnostic'] | undefined {
  if (line.byteLength === 0 || line.byteLength > MAX_DIAGNOSTIC_LINE_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(line.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).sort().join(',') !== 'code,kind,v') return undefined;
    if (raw.kind !== 'clowder.plugin.runtime-error' || raw.v !== 1) return undefined;
    if (typeof raw.code !== 'string' || !RUNTIME_DIAGNOSTIC_CODES.has(raw.code)) return undefined;
    return { code: raw.code as NonNullable<ExternalPluginProcessExit['diagnostic']>['code'] };
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class NodeExternalPluginProcessAdapter implements ExternalPluginProcessAdapter {
  private readonly childPids = new Set<number>();

  constructor(private readonly terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS) {
    process.once('exit', () => {
      for (const pid of this.childPids) {
        try {
          this.signalProcessTree(pid, 'SIGTERM');
        } catch {
          // Parent shutdown is already terminal; cleanup remains best effort.
        }
      }
    });
  }

  async spawn(spec: ExternalPluginProcessSpec): Promise<ExternalPluginProcess> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        detached: platform() !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new ExternalPluginRuntimeError('PROCESS_START_FAILED', 'failed to create plugin process', { cause: error });
    }
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    }).catch((error) => {
      throw new ExternalPluginRuntimeError('PROCESS_START_FAILED', 'plugin process failed before spawn', {
        cause: error,
      });
    });
    if (child.pid === undefined) {
      throw new ExternalPluginRuntimeError('PROCESS_START_FAILED', 'plugin process did not receive a pid');
    }
    const pid = child.pid;
    this.childPids.add(pid);
    let diagnostic: ExternalPluginProcessExit['diagnostic'];
    let pendingDiagnostic = Buffer.alloc(0);
    let discardingOversizedDiagnostic = false;
    const appendDiagnosticFragment = (fragment: Buffer): void => {
      if (discardingOversizedDiagnostic) return;
      if (pendingDiagnostic.byteLength + fragment.byteLength > MAX_DIAGNOSTIC_LINE_BYTES) {
        pendingDiagnostic = Buffer.alloc(0);
        discardingOversizedDiagnostic = true;
        return;
      }
      pendingDiagnostic = Buffer.concat([pendingDiagnostic, fragment]);
    };
    const finishDiagnosticLine = (): ExternalPluginProcessExit['diagnostic'] | undefined => {
      const parsed = discardingOversizedDiagnostic ? undefined : parseRuntimeDiagnostic(pendingDiagnostic);
      pendingDiagnostic = Buffer.alloc(0);
      discardingOversizedDiagnostic = false;
      return parsed;
    };
    child.stderr.on('data', (chunk: Buffer) => {
      let cursor = 0;
      while (cursor < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, cursor);
        const fragmentEnd = newline < 0 ? chunk.byteLength : newline;
        appendDiagnosticFragment(chunk.subarray(cursor, fragmentEnd));
        if (newline < 0) break;
        diagnostic = finishDiagnosticLine() ?? diagnostic;
        cursor = newline + 1;
      }
    });
    const exited = new Promise<ExternalPluginProcessExit>((resolve) => {
      const settle = (result: ExternalPluginProcessExit) => {
        child.off('close', onExit);
        child.off('error', onError);
        this.childPids.delete(pid);
        resolve(result);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        settle({ code, signal, ...(diagnostic === undefined ? {} : { diagnostic }) });
      const onError = () => settle({ code: null, signal: null, ...(diagnostic === undefined ? {} : { diagnostic }) });
      child.once('close', onExit);
      child.once('error', onError);
    });
    let terminating: Promise<void> | undefined;
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      pid,
      exited,
      terminate: () => {
        terminating ??= this.terminateProcess(pid, exited);
        return terminating;
      },
    };
  }

  private async terminateProcess(pid: number, exited: Promise<ExternalPluginProcessExit>): Promise<void> {
    this.signalProcessTree(pid, 'SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), delay(this.terminationGraceMs).then(() => false)]);
    if (graceful) return;
    this.signalProcessTree(pid, 'SIGKILL');
    await exited;
  }

  private signalProcessTree(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(platform() === 'win32' ? pid : -pid, signal);
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
}
