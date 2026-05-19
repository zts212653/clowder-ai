import { execFile, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ServiceLifecycleAction = 'install' | 'start' | 'stop' | 'uninstall' | 'toggle';

export interface ServiceLifecycleManifest {
  id: string;
  scripts?: {
    install?: string;
    start?: string;
    uninstall?: string;
  };
}

export interface ServiceLifecycleRunInput {
  serviceId: string;
  action: ServiceLifecycleAction;
  scriptPath: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  timeoutMs: number;
}

export interface ServiceLifecycleRunResult {
  code: number | null;
  output?: string;
  pid?: number;
  timedOut?: boolean;
  runnerError?: boolean;
}

export type ServiceLifecycleRunner = (input: ServiceLifecycleRunInput) => Promise<ServiceLifecycleRunResult>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SERVICE_SCRIPT_DIR = resolve(REPO_ROOT, 'scripts/services');
const MODEL_ID_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/;
const MAX_CAPTURED_OUTPUT = 8192;

function isPathInside(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

export function isValidModelId(model: string): boolean {
  return MODEL_ID_PATTERN.test(model) && model.length <= 200;
}

export function resolveServiceScriptPath(script: string): string {
  if (!script.startsWith('scripts/services/')) {
    throw new Error(`Service script path is outside scripts/services: ${script}`);
  }
  const resolved = resolve(REPO_ROOT, script);
  if (!isPathInside(SERVICE_SCRIPT_DIR, resolved)) {
    throw new Error(`Service script path is outside repository services directory: ${script}`);
  }
  if (existsSync(resolved)) {
    const realScriptDir = realpathSync(SERVICE_SCRIPT_DIR);
    const realScriptPath = realpathSync(resolved);
    if (!isPathInside(realScriptDir, realScriptPath)) {
      throw new Error(`Service script resolves outside repository services directory: ${script}`);
    }
  }
  return resolved;
}

export function isServiceProcessCommand(command: string, manifest: ServiceLifecycleManifest): boolean {
  const startScript = manifest.scripts?.start;
  if (!startScript) return false;
  const normalizedCommand = command.replaceAll('\\', '/');
  const resolvedScript = resolveServiceScriptPath(startScript).replaceAll('\\', '/');
  const tokens = Array.from(normalizedCommand.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (match) => {
    return match[1] ?? match[2] ?? match[3] ?? '';
  });
  let commandIndex = 0;
  if (basename(tokens[commandIndex] ?? '') === 'env') {
    commandIndex += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex] ?? '')) commandIndex += 1;
  }
  const isScriptToken = (token: string | undefined): boolean => {
    if (!token) return false;
    return token === resolvedScript;
  };
  const executable = tokens[commandIndex];
  if (isScriptToken(executable)) return true;
  if (['bash', 'sh', 'zsh'].includes(basename(executable ?? ''))) {
    return isScriptToken(tokens[commandIndex + 1]);
  }
  return false;
}

export async function readProcessCommand(pid: number): Promise<string | null> {
  return new Promise((resolveCommand) => {
    const child = execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 2000 }, (error, stdout) => {
      if (error) {
        resolveCommand(null);
        return;
      }
      const command = stdout.trim();
      resolveCommand(command.length > 0 ? command : null);
    });
    child.on('error', () => resolveCommand(null));
  });
}

export async function findPidsByPort(port: number): Promise<number[]> {
  return new Promise((resolvePids, rejectPids) => {
    const child = execFile(
      'lsof',
      ['-ti', `TCP:${port}`, '-sTCP:LISTEN'],
      { timeout: 3000 },
      (error, stdout, stderr) => {
        if (error) {
          const code = Number((error as { code?: unknown }).code);
          const noMatches = code === 1 && stdout.trim().length === 0 && stderr.trim().length === 0;
          if (noMatches) {
            resolvePids([]);
            return;
          }
          rejectPids(new Error(`lsof port probe failed for TCP:${port}`));
          return;
        }
        const currentPid = process.pid;
        resolvePids(
          stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((value) => Number(value))
            .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== currentPid),
        );
      },
    );
    child.on('error', (error) => rejectPids(error));
  });
}

function resolveLogDir(): string {
  return process.env.LOG_DIR ?? resolve(REPO_ROOT, 'data/logs/api');
}

export function appendServiceLog(serviceId: string, chunk: string): void {
  try {
    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    appendFileSync(resolve(logDir, `${serviceId}.log`), chunk);
  } catch {
    // best-effort logging only
  }
}

export function readServiceLogTail(serviceId: string, lines = 100): string[] {
  const logPath = resolve(resolveLogDir(), `${serviceId}.log`);
  if (!existsSync(logPath)) return [];
  try {
    const fd = openSync(logPath, 'r');
    try {
      const stat = fstatSync(fd);
      const maxRead = 256 * 1024;
      const readSize = Math.min(stat.size, maxRead);
      if (readSize === 0) return [];
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
      return buffer.toString('utf-8').split('\n').slice(-lines).filter(Boolean);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

export async function runServiceScript(input: ServiceLifecycleRunInput): Promise<ServiceLifecycleRunResult> {
  if (input.detached) {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn('bash', [input.scriptPath], {
        detached: true,
        stdio: 'ignore',
        env: input.env,
      });
      child.on('error', (error) => rejectRun(error));
      const earlyExitTimer = setTimeout(() => {
        child.unref();
        resolveRun({ code: null, pid: child.pid });
      }, 2000);
      child.on('exit', (code) => {
        clearTimeout(earlyExitTimer);
        resolveRun({ code, pid: child.pid, output: '' });
      });
    });
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = execFile('bash', [input.scriptPath], {
      env: input.env,
      timeout: input.detached ? undefined : input.timeoutMs,
      windowsHide: true,
    });
    let output = '';
    const appendOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (output.length > MAX_CAPTURED_OUTPUT) output = output.slice(-MAX_CAPTURED_OUTPUT);
      appendServiceLog(input.serviceId, text);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.on('error', (error) => rejectRun(error));
    child.on('close', (code, signal) => {
      const timedOut = signal === 'SIGTERM';
      resolveRun({ code, output, pid: child.pid, timedOut });
    });
  });
}
