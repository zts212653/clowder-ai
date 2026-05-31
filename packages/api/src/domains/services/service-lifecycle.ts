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
  settlement?: Promise<ServiceLifecycleSettledRunResult>;
}

export type ServiceLifecycleSettledRunResult = Omit<ServiceLifecycleRunResult, 'settlement'>;
export interface ProcessSnapshot {
  pid: number;
  command: string | null;
}

export type ServiceLifecycleRunner = (input: ServiceLifecycleRunInput) => Promise<ServiceLifecycleRunResult>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SERVICE_SCRIPT_DIR = resolve(REPO_ROOT, 'scripts/services');
// Accept both Hugging Face org/name form (e.g. mlx-community/whisper-large-v3-turbo)
// AND library-native shorthand (e.g. faster-whisper's `large-v3-turbo`, `base`).
// The recommendation matrix uses shorthand for faster-whisper on non-Apple-Silicon
// platforms — see codex P1 3269025145. Both forms are safe under the
// `[a-zA-Z0-9._-]+` char class (no path traversal, no shell metachars).
const MODEL_ID_PATTERN = /^([a-zA-Z0-9_-]+\/)?[a-zA-Z0-9._-]+$/;
const MAX_CAPTURED_OUTPUT = 8192;

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide?: boolean },
  callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void,
) => { on(event: 'error', listener: (error: Error) => void): unknown };

interface ProbeOptions {
  platform?: NodeJS.Platform;
  execFile?: ExecFileLike;
}

function isPathInside(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function formatRunnerCommandPart(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

export function shouldDetachServiceRunner(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

function resolveServiceRuntimeScriptPaths(
  manifest: ServiceLifecycleManifest,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const startScript = manifest.scripts?.start;
  if (!startScript) return [];

  const resolvedStartScript = resolveServiceScriptPath(startScript, platform);
  const runtimeScripts: string[] = [];
  const serverMatch = basename(resolvedStartScript).match(/^(.+)-server\.(?:sh|ps1)$/i);
  if (serverMatch) {
    runtimeScripts.push(resolve(dirname(resolvedStartScript), `${serverMatch[1]}-api.py`));
  }
  if (manifest.id === 'audio-capture') {
    runtimeScripts.push(resolve(REPO_ROOT, 'scripts/meeting-copilot/audio-service.py'));
  }
  return runtimeScripts.filter((scriptPath) => isPathInside(REPO_ROOT, scriptPath));
}

export function isValidModelId(model: string): boolean {
  return MODEL_ID_PATTERN.test(model) && model.length <= 200;
}

export function resolveServiceScriptPath(script: string, platform: NodeJS.Platform = process.platform): string {
  if (!script.startsWith('scripts/services/')) {
    throw new Error(`Service script path is outside scripts/services: ${script}`);
  }
  let effectiveScript = script;
  if (platform === 'win32' && script.endsWith('.sh')) {
    const powershellScript = `${script.slice(0, -3)}.ps1`;
    const powershellPath = resolve(REPO_ROOT, powershellScript);
    if (isPathInside(SERVICE_SCRIPT_DIR, powershellPath) && existsSync(powershellPath)) {
      effectiveScript = powershellScript;
    }
  }
  const resolved = resolve(REPO_ROOT, effectiveScript);
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

export function isServiceProcessCommand(
  command: string,
  manifest: ServiceLifecycleManifest,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const startScript = manifest.scripts?.start;
  if (!startScript) return false;
  const normalizePath = (value: string): string => {
    const normalized = value.replaceAll('\\', '/');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const normalizedCommand = normalizePath(command);
  const resolvedScript = normalizePath(resolveServiceScriptPath(startScript, platform));
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
  if (['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'].includes(basename(executable ?? ''))) {
    const fileFlagIndex = tokens.findIndex((token, index) => index > commandIndex && token.toLowerCase() === '-file');
    return fileFlagIndex >= 0 && isScriptToken(tokens[fileFlagIndex + 1]);
  }
  const runtimeScripts = resolveServiceRuntimeScriptPaths(manifest, platform).map((scriptPath) =>
    normalizePath(scriptPath),
  );
  const isPythonExecutable = /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(basename(executable ?? ''));
  if (isPythonExecutable && runtimeScripts.includes(tokens[commandIndex + 1] ?? '')) {
    return true;
  }
  return false;
}

function parsePidLines(stdout: string): number[] {
  const currentPid = process.pid;
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== currentPid);
}

function parseNetstatPids(stdout: string, port: number): number[] {
  const currentPid = process.pid;
  const pids = new Set<number>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const columns = rawLine.trim().split(/\s+/);
    if (columns.length < 5 || columns[0]?.toUpperCase() !== 'TCP') continue;
    const [, localAddress, , state, pidValue] = columns;
    const portMatch = localAddress?.match(/:(\d+)$/);
    if (!portMatch || Number(portMatch[1]) !== port) continue;
    if (state?.toUpperCase() !== 'LISTENING') continue;
    const pid = Number(pidValue);
    if (Number.isFinite(pid) && pid > 0 && pid !== currentPid) pids.add(pid);
  }
  return [...pids];
}

function parsePsProcessLines(stdout: string): ProcessSnapshot[] {
  return stdout
    .split(/\r?\n/)
    .map((rawLine) => {
      const match = rawLine.match(/^\s*(\d+)\s+(.*)$/);
      if (!match) return null;
      const pid = Number(match[1]);
      const command = match[2]?.trim() ?? '';
      if (!Number.isFinite(pid) || pid <= 0) return null;
      return { pid, command: command.length > 0 ? command : null };
    })
    .filter((entry): entry is ProcessSnapshot => entry !== null);
}

function parseWindowsProcessLines(stdout: string): ProcessSnapshot[] {
  return stdout
    .split(/\r?\n/)
    .map((rawLine) => {
      const line = rawLine.trim();
      if (!line) return null;
      const [pidValue, ...rest] = line.split('\t');
      const pid = Number(pidValue);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      const command = rest.join('\t').trim();
      return { pid, command: command.length > 0 ? command : null };
    })
    .filter((entry): entry is ProcessSnapshot => entry !== null);
}

function execProbeCommand(
  execFileImpl: ExecFileLike,
  file: string,
  args: string[],
  options: { timeout: number; windowsHide?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProbe, rejectProbe) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const child = execFileImpl(file, args, options, (error, stdout, stderr) => {
      settle(() => {
        if (error) {
          const suffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : '';
          rejectProbe(new Error(`${error.message}${suffix}`));
          return;
        }
        resolveProbe({ stdout, stderr });
      });
    });
    child.on('error', (error) => {
      settle(() => rejectProbe(error));
    });
  });
}

export async function readProcessCommand(pid: number, options: ProbeOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFile ?? (execFile as ExecFileLike);
  if (platform === 'win32') {
    return new Promise((resolveCommand) => {
      const script = [
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
        'if ($process -and $process.CommandLine) { $process.CommandLine } elseif ($process) { $process.ExecutablePath }',
      ].join('; ');
      const child = execFileImpl(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 2000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolveCommand(null);
            return;
          }
          const command = stdout.trim();
          resolveCommand(command.length > 0 ? command : null);
        },
      );
      child.on('error', () => resolveCommand(null));
    });
  }
  return new Promise((resolveCommand) => {
    const child = execFileImpl('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 2000 }, (error, stdout) => {
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

export async function findPidsByPort(port: number, options: ProbeOptions = {}): Promise<number[]> {
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFile ?? (execFile as ExecFileLike);
  if (platform === 'win32') {
    const script = [
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
      'Select-Object -ExpandProperty OwningProcess',
      'Sort-Object -Unique',
    ].join(' | ');
    try {
      const { stdout } = await execProbeCommand(
        execFileImpl,
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 3000, windowsHide: true },
      );
      return parsePidLines(stdout);
    } catch (powershellError) {
      try {
        const { stdout } = await execProbeCommand(execFileImpl, 'netstat.exe', ['-ano', '-p', 'tcp'], {
          timeout: 3000,
          windowsHide: true,
        });
        return parseNetstatPids(stdout, port);
      } catch (netstatError) {
        throw new Error(
          `Windows port probe failed for TCP:${port}: PowerShell=${(powershellError as Error).message}; netstat=${
            (netstatError as Error).message
          }`,
        );
      }
    }
  }
  return new Promise((resolvePids, rejectPids) => {
    const child = execFileImpl(
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
        resolvePids(parsePidLines(stdout));
      },
    );
    child.on('error', (error) => rejectPids(error));
  });
}

export async function listProcesses(options: ProbeOptions = {}): Promise<ProcessSnapshot[]> {
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFile ?? (execFile as ExecFileLike);
  if (platform === 'win32') {
    const script = [
      'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {',
      '  $cmd = if ($_.CommandLine) { $_.CommandLine } elseif ($_.ExecutablePath) { $_.ExecutablePath } else { "" }',
      '  if ($cmd) { "{0}`t{1}" -f $_.ProcessId, $cmd }',
      '}',
    ].join(' ');
    const { stdout } = await execProbeCommand(
      execFileImpl,
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 3000, windowsHide: true },
    );
    return parseWindowsProcessLines(stdout);
  }
  const { stdout } = await execProbeCommand(execFileImpl, 'ps', ['-eo', 'pid=,command='], { timeout: 3000 });
  return parsePsProcessLines(stdout);
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
  const command =
    process.platform === 'win32' && input.scriptPath.toLowerCase().endsWith('.ps1') ? 'powershell.exe' : 'bash';
  const args =
    command === 'powershell.exe'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', input.scriptPath]
      : [input.scriptPath];
  appendServiceLog(
    input.serviceId,
    `[${input.action}] invoking runner: ${[command, ...args].map(formatRunnerCommandPart).join(' ')}\n`,
  );

  if (input.detached) {
    return new Promise((resolveRun, rejectRun) => {
      let output = '';
      let resolvedEarly = false;
      let resolveSettlement: (result: ServiceLifecycleSettledRunResult) => void = () => {};
      const settlement = new Promise<ServiceLifecycleSettledRunResult>((resolve) => {
        resolveSettlement = resolve;
      });
      const appendOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        if (output.length > MAX_CAPTURED_OUTPUT) output = output.slice(-MAX_CAPTURED_OUTPUT);
        appendServiceLog(input.serviceId, text);
      };
      const child = spawn(command, args, {
        detached: shouldDetachServiceRunner(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: input.env,
        windowsHide: true,
      });
      appendServiceLog(input.serviceId, `[${input.action}] runner pid=${child.pid ?? 'unknown'}\n`);
      child.stdout?.on('data', appendOutput);
      child.stderr?.on('data', appendOutput);
      child.on('error', (error) => {
        if (resolvedEarly) {
          appendServiceLog(input.serviceId, `[${input.action}] runner error: ${error.message}\n`);
          resolveSettlement({ code: null, output, pid: child.pid, runnerError: true });
          return;
        }
        appendServiceLog(input.serviceId, `[${input.action}] runner spawn failed: ${error.message}\n`);
        rejectRun(error);
      });
      const earlyExitTimer = setTimeout(() => {
        resolvedEarly = true;
        child.unref();
        // Both pipe streams must also be unref'd. Without this, the
        // parent Node process is held alive by the still-ref'd pipe
        // handles until the detached child exits — which would block
        // API server restart/shutdown on long-lived sidecars (砚砚 P1).
        // Tests that need to `await settlement` should keep the event
        // loop alive themselves with a test-scoped ref'd timer; do not
        // bake that into production runner behavior.
        (child.stdout as { unref?: () => void } | null)?.unref?.();
        (child.stderr as { unref?: () => void } | null)?.unref?.();
        resolveRun({ code: null, pid: child.pid, output, settlement });
      }, 2000);
      child.on('close', (code, signal) => {
        clearTimeout(earlyExitTimer);
        const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        appendServiceLog(input.serviceId, `[${input.action}] runner exited with ${status}\n`);
        if (resolvedEarly && (code !== 0 || signal)) {
          appendServiceLog(input.serviceId, `[${input.action}] process exited with ${status}\n`);
        }
        const result = { code, output, pid: child.pid };
        resolveSettlement(result);
        if (!resolvedEarly) {
          resolvedEarly = true;
          resolveRun({ ...result, settlement });
        }
      });
    });
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(command, args, {
      env: input.env,
      timeout: input.detached ? undefined : input.timeoutMs,
      windowsHide: true,
    });
    appendServiceLog(input.serviceId, `[${input.action}] runner pid=${child.pid ?? 'unknown'}\n`);
    let output = '';
    const appendOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (output.length > MAX_CAPTURED_OUTPUT) output = output.slice(-MAX_CAPTURED_OUTPUT);
      appendServiceLog(input.serviceId, text);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.on('error', (error) => {
      appendServiceLog(input.serviceId, `[${input.action}] runner spawn failed: ${error.message}\n`);
      rejectRun(error);
    });
    child.on('close', (code, signal) => {
      const timedOut = signal === 'SIGTERM';
      const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      appendServiceLog(input.serviceId, `[${input.action}] runner exited with ${status}\n`);
      resolveRun({ code, output, pid: child.pid, timedOut });
    });
  });
}
