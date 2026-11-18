import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type LivenessWarningEvent,
  type ProbeConfig,
  ProcessLivenessProbe,
} from '../../../../../../../utils/ProcessLivenessProbe.js';

export interface AgyVersionProbeOptions {
  readonly signal?: AbortSignal;
  readonly livenessProbe?: Partial<ProbeConfig>;
  readonly onVersionWarning?: (warning: LivenessWarningEvent) => void;
}

const execFileAsync = promisify(execFile);

/** An owner-local identity probe is warning-only and joins its actual child on cancellation. */
export async function readAgyVersion(command: string, options: AgyVersionProbeOptions): Promise<string> {
  const pending = execFileAsync(command, ['--version'], {
    encoding: 'utf8',
    signal: options.signal,
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
    env: { PATH: process.env.PATH ?? '', LANG: 'C' },
  });
  pending.child.stdin?.end();
  const stopped = new Promise<void>((resolve) => pending.child.once('close', () => resolve()));
  const probe =
    options.onVersionWarning && pending.child.pid
      ? new ProcessLivenessProbe(pending.child.pid, options.livenessProbe)
      : undefined;
  const drain = () => {
    for (const warning of probe?.drainWarnings() ?? []) options.onVersionWarning?.(warning);
  };
  const timer = probe ? setInterval(drain, Math.min(probe.config.sampleIntervalMs, 250)) : undefined;
  timer?.unref();
  pending.child.stdout?.on('data', () => probe?.notifyActivity());
  probe?.start();
  try {
    return (await pending).stdout;
  } finally {
    await stopped;
    if (timer) clearInterval(timer);
    probe?.stop();
    await probe?.flushPendingWarnings();
    drain();
  }
}
