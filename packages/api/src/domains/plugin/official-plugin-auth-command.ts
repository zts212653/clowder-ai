import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const INVALID_JSON = Symbol('invalid-json');
const STRUCTURED_OPENERS_BY_CLOSER: Readonly<Record<string, string | undefined>> = {
  '}': '{',
  ']': '[',
};
const STRUCTURED_OPENERS = new Set(['{', '[']);

export interface OfficialPluginAuthCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface OfficialPluginAuthCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export function officialPluginAuthCommandEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    HOME: process.env.HOME?.trim() || homedir(),
    PATH: process.env.PATH?.trim() || '/usr/bin:/bin',
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  };
  for (const key of [
    'USER',
    'LOGNAME',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  return env;
}

export function runOfficialPluginAuthCommand(
  spec: OfficialPluginAuthCommandSpec,
): Promise<OfficialPluginAuthCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let terminalError: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    const signalTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
          killer.unref();
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        child.kill(signal);
      }
    };
    const terminate = (): void => {
      signalTree('SIGTERM');
      if (escalation !== undefined) return;
      escalation = setTimeout(() => signalTree('SIGKILL'), 3_000);
      escalation.unref();
    };
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminalError = new Error('lark-cli authentication output exceeded the Host limit');
        terminate();
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', (error) => {
      terminalError = new Error('lark-cli authentication command failed', { cause: error });
    });

    const timeout = setTimeout(() => {
      terminalError = new Error('lark-cli authentication command timed out');
      terminate();
    }, spec.timeoutMs);
    timeout.unref();
    const onAbort = (): void => {
      terminalError = new Error('lark-cli authentication command was cancelled');
      terminate();
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    if (spec.signal?.aborted) onAbort();

    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      spec.signal?.removeEventListener('abort', onAbort);
      if (terminalError || code !== 0) {
        reject(terminalError ?? new Error(`lark-cli authentication command exited (${code ?? signal ?? 'unknown'})`));
        return;
      }
      resolveResult({ stdout, stderr });
    });
  });
}

function isUnescapedQuoteAt(output: string, index: number): boolean {
  if (output[index] !== '"') return false;
  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && output[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 0;
}

function startsAtIndentedLine(output: string, index: number): boolean {
  const lineStart = output.lastIndexOf('\n', index - 1) + 1;
  return /^[\t ]*$/.test(output.slice(lineStart, index));
}

function findTrailingStructuredValueStart(output: string): number | undefined {
  const lastIndex = output.length - 1;
  const expectedOpeners: string[] = [];
  let insideString = false;
  for (let index = lastIndex; index >= 0; index -= 1) {
    const character = output[index];
    if (isUnescapedQuoteAt(output, index)) {
      insideString = !insideString;
      continue;
    }
    if (insideString) continue;
    const structuredOpener = STRUCTURED_OPENERS_BY_CLOSER[character];
    if (structuredOpener !== undefined) {
      expectedOpeners.push(structuredOpener);
      continue;
    }
    if (!STRUCTURED_OPENERS.has(character)) continue;
    if (expectedOpeners.at(-1) !== character) return undefined;
    expectedOpeners.pop();
    if (expectedOpeners.length > 0) continue;
    return startsAtIndentedLine(output, index) ? index : undefined;
  }
  return undefined;
}

function tryParseJson(output: string): unknown | typeof INVALID_JSON {
  try {
    return JSON.parse(output);
  } catch {
    return INVALID_JSON;
  }
}

export function parseLarkCliJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) throw new Error('lark-cli returned no structured output');
  const entireOutput = tryParseJson(trimmed);
  if (entireOutput !== INVALID_JSON) return entireOutput;

  const trailingStructuredValueStart = findTrailingStructuredValueStart(trimmed);
  if (trailingStructuredValueStart !== undefined) {
    const trailingStructuredValue = tryParseJson(trimmed.slice(trailingStructuredValueStart));
    if (trailingStructuredValue !== INVALID_JSON) return trailingStructuredValue;
  }
  for (const line of trimmed.split('\n').reverse()) {
    const compactValue = tryParseJson(line);
    if (compactValue !== INVALID_JSON) return compactValue;
  }
  throw new Error('lark-cli returned invalid structured output');
}
