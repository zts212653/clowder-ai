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
    child.stderr.resume();
    const exited = new Promise<ExternalPluginProcessExit>((resolve) => {
      const settle = (result: ExternalPluginProcessExit) => {
        child.off('exit', onExit);
        child.off('error', onError);
        this.childPids.delete(pid);
        resolve(result);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal });
      const onError = () => settle({ code: null, signal: null });
      child.once('exit', onExit);
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
