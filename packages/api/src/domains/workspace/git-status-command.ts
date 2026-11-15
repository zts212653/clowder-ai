import { spawn } from 'node:child_process';

type Phase = 'status' | 'untracked-expansion';
type Failure = 'timeout' | 'exit' | 'spawn' | 'parse';
interface StatusCommandOptions {
  startedAt: number;
  phase: Phase;
  parser: { write(chunk: string): void; finish(): void };
}
interface GitStatusDiagnostics {
  phase: Phase;
  reason: Failure;
  elapsedMs: number;
  phaseElapsedMs: number;
  firstOutputMs: number | null;
  stdoutBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  gitRegion: string | null;
}

export class GitStatusReadError extends Error {
  constructor(public readonly diagnostics: GitStatusDiagnostics) {
    super(diagnostics.reason === 'timeout' ? 'Git status timed out' : 'Git status failed');
    this.name = 'GitStatusReadError';
  }
}

/** Consume bounded Trace2 metadata; never include command arguments, paths or stderr in logs. */
function createRegionReader() {
  let pending = '';
  let skipping = false;
  const regions: string[] = [];
  const consume = (line: string) => {
    try {
      const event: unknown = JSON.parse(line);
      if (typeof event !== 'object' || event === null) return;
      const record = event as Record<string, unknown>;
      if (record.thread !== 'main') return;
      if (record.event === 'region_enter' && typeof record.category === 'string' && typeof record.label === 'string') {
        if (regions.length < 64) regions.push(`${record.category}/${record.label}`.slice(0, 160));
      } else if (record.event === 'region_leave') regions.pop();
    } catch {
      // Ordinary stderr and malformed/oversized trace lines have no bearing on results.
    }
  };
  return {
    current: () => regions.at(-1) ?? null,
    write(chunk: string) {
      for (const part of chunk.split(/(?<=\n)/)) {
        const complete = part.endsWith('\n');
        if (!skipping && pending.length + part.length <= 8192) pending += part;
        else {
          pending = '';
          skipping = true;
        }
        if (complete) {
          if (!skipping) consume(pending);
          pending = '';
          skipping = false;
        }
      }
    },
  };
}

/** Stream without an output limit; the initial read and every expansion share five seconds. */
export async function runGitStatusCommand(root: string, args: string[], options: StatusCommandOptions): Promise<void> {
  const phaseStartedAt = performance.now();
  let firstOutputMs: number | null = null;
  let stdoutBytes = 0;
  const trace = createRegionReader();
  const failure = (reason: Failure, exitCode: number | null = null, signal: NodeJS.Signals | null = null) =>
    new GitStatusReadError({
      phase: options.phase,
      reason,
      elapsedMs: Math.round(performance.now() - options.startedAt),
      phaseElapsedMs: Math.round(performance.now() - phaseStartedAt),
      firstOutputMs,
      stdoutBytes,
      exitCode,
      signal,
      gitRegion: trace.current(),
    });
  const remaining = 5000 - (phaseStartedAt - options.startedAt);
  if (remaining <= 0) throw failure('timeout');
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    if (env.GIT_TRACE2_EVENT === undefined) {
      env.GIT_TRACE2_EVENT = '2';
      env.GIT_TRACE2_EVENT_NESTING = '20';
    }
    const child = spawn('git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const finish = (error?: GitStatusReadError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(failure('timeout', null, 'SIGKILL'));
    }, remaining);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (!settled) trace.write(chunk);
    });
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      firstOutputMs ??= Math.round(performance.now() - phaseStartedAt);
      stdoutBytes += Buffer.byteLength(chunk);
      try {
        options.parser.write(chunk);
      } catch {
        child.kill('SIGKILL');
        finish(failure('parse'));
      }
    });
    child.on('error', () => finish(failure('spawn')));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) return finish(failure('exit', code, signal));
      try {
        options.parser.finish();
        finish();
      } catch {
        finish(failure('parse'));
      }
    });
  });
}
