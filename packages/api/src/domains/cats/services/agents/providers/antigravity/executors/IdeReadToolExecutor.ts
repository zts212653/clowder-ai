import { spawn } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isDenylisted, resolveWorkspacePath } from '../../../../../../workspace/workspace-security.js';
import type { TrajectoryStep } from '../AntigravityBridge.js';
import { isReadOnlyMcpTool } from '../antigravity-step-effects.js';
import type { AntigravityToolExecutor, ExecutorContext, ExecutorResult } from './AntigravityToolExecutor.js';
import { resolveToolName } from './ExecutorRegistry.js';

export const ANTIGRAVITY_IDE_READ_TOOL_NAMES = ['grep_search', 'list_dir', 'read_file', 'view_file'] as const;
export type AntigravityIdeReadToolName = (typeof ANTIGRAVITY_IDE_READ_TOOL_NAMES)[number];

const IDE_READ_TOOLS = new Set<string>(ANTIGRAVITY_IDE_READ_TOOL_NAMES);
const DEFAULT_MAX_LINES = 300;
const HARD_MAX_LINES = 500;
const HARD_MAX_BYTES = 32_768;
const READ_BUDGET_BYTES = 1_048_576;
const MAX_SEARCH_RESULTS = 50;
const SEARCH_RESULT_SENTINEL = MAX_SEARCH_RESULTS + 1;
const RG_TIMEOUT_MS = 10_000;
const STDERR_CAPTURE_BYTES = 32_768;
const RG_DENYLIST_GLOBS = ['!.env*', '!*.pem', '!*.key', '!id_rsa*', '!.git', '!secrets'];
let ripgrepBinaryPromise: Promise<string> | undefined;

function durationSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function stringArg(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberArg(input: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringArrayArg(input: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
    if (Array.isArray(value)) {
      const values = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      if (values.length > 0) return values;
    }
  }
  return [];
}

function pathArg(input: Record<string, unknown>, keys: string[] = []): string {
  const value = stringArg(input, [
    ...keys,
    'Path',
    'path',
    'FilePath',
    'filePath',
    'file_path',
    'AbsolutePath',
    'absolutePath',
  ]);
  return value === undefined ? '.' : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonTextField(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.bytes === 'string') return Buffer.from(value.bytes, 'base64').toString('utf8');
  return undefined;
}

function formatAndTruncateSearchLines(lines: string[]): string {
  if (lines.length === 0) return 'No matches found.';
  if (lines.length <= MAX_SEARCH_RESULTS) return lines.join('\n');
  return `${lines.slice(0, MAX_SEARCH_RESULTS).join('\n')}\n\n[Truncated: ${MAX_SEARCH_RESULTS}/${lines.length} matches shown.]`;
}

function ripgrepJsonMatchLine(rawLine: string): string | undefined {
  if (!rawLine.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || parsed.type !== 'match' || !isRecord(parsed.data)) return undefined;

  const relPath = jsonTextField(parsed.data.path);
  const lineText = jsonTextField(parsed.data.lines);
  const lineNumber = parsed.data.line_number;
  if (!relPath || typeof lineText !== 'string' || typeof lineNumber !== 'number') return undefined;
  if (isDenylisted(relPath)) return undefined;

  return `${relPath}:${lineNumber}:${lineText.replace(/\r?\n$/, '')}`;
}

function filterAndTruncateRipgrepJson(stdout: string): string {
  const lines: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    const formatted = ripgrepJsonMatchLine(rawLine);
    if (formatted) lines.push(formatted);
  }
  return formatAndTruncateSearchLines(lines);
}

export const filterAndTruncateRipgrepJsonForTest = filterAndTruncateRipgrepJson;

async function resolveRipgrepBinary(): Promise<string> {
  const configured = process.env.CAT_CAFE_RIPGREP_PATH?.trim();
  if (configured) return configured;

  try {
    const { rgPath } = await import('@vscode/ripgrep');
    if (typeof rgPath === 'string' && rgPath.length > 0) return rgPath;
  } catch {
    // Fall through to PATH lookup for development shells and system installs.
  }

  return 'rg';
}

async function executeRipgrepJson(args: string[], cwd: string): Promise<string> {
  ripgrepBinaryPromise ??= resolveRipgrepBinary();
  const ripgrepBinary = await ripgrepBinaryPromise;

  return new Promise((resolve, reject) => {
    const child = spawn(ripgrepBinary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let stdoutRemainder = '';
    let stderr = '';
    let timedOut = false;
    let stoppedAfterEnoughMatches = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 300);
    }, RG_TIMEOUT_MS);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };

    const recordLine = (rawLine: string): void => {
      if (lines.length >= SEARCH_RESULT_SENTINEL) return;
      const formatted = ripgrepJsonMatchLine(rawLine);
      if (!formatted) return;
      lines.push(formatted);
      if (lines.length >= SEARCH_RESULT_SENTINEL && !stoppedAfterEnoughMatches) {
        stoppedAfterEnoughMatches = true;
        child.kill('SIGTERM');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutRemainder += chunk;
      let newlineIndex = stdoutRemainder.indexOf('\n');
      while (newlineIndex !== -1) {
        const rawLine = stdoutRemainder.slice(0, newlineIndex);
        stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
        recordLine(rawLine);
        newlineIndex = stdoutRemainder.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_CAPTURE_BYTES);
    });

    child.once('error', (err) => finish(() => reject(err)));
    child.once('close', (code, signal) => {
      if (stdoutRemainder.length > 0) recordLine(stdoutRemainder);
      finish(() => {
        if (timedOut) {
          reject(new Error('grep_search timed out after 10000ms'));
          return;
        }
        if (stoppedAfterEnoughMatches || code === 0 || code === 1) {
          resolve(formatAndTruncateSearchLines(lines));
          return;
        }
        const detail = stderr.trim() || `rg exited with code ${String(code)}${signal ? ` signal ${signal}` : ''}`;
        reject(new Error(detail));
      });
    });
  });
}

async function executeGrepSearch(input: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = stringArg(input, ['Pattern', 'pattern', 'Query', 'query', 'SearchTerm', 'searchTerm']);
  if (!pattern) throw new Error('grep_search requires Pattern');

  const searchPath = pathArg(input, ['SearchPath', 'searchPath', 'search_path']);
  await resolveWorkspacePath(cwd, searchPath);

  const args = ['--no-config', '--json', '--max-count', '100', '-e', pattern];
  const includes = stringArrayArg(input, ['Include', 'include', 'Includes', 'includes', 'Glob', 'glob']);
  for (const include of includes) args.push('--glob', include);
  args.push(...RG_DENYLIST_GLOBS.flatMap((g) => ['--glob', g]));
  args.push('--', searchPath);

  return executeRipgrepJson(args, cwd);
}

async function executeListDir(input: Record<string, unknown>, cwd: string): Promise<string> {
  const dirPath = pathArg(input, ['DirectoryPath', 'directoryPath', 'directory_path']);
  const resolved = await resolveWorkspacePath(cwd, dirPath);
  const entries = await readdir(resolved, { withFileTypes: true });
  const dirRel = relative(cwd, resolved);
  const prefix = dirRel === '' ? '' : dirRel;
  const filtered = entries.filter((entry) => !isDenylisted(join(prefix, entry.name)));
  if (filtered.length === 0) return '(empty directory)';
  return filtered
    .map((entry) => `${entry.isDirectory() ? '[dir]  ' : '[file] '}${entry.name}`)
    .sort()
    .join('\n');
}

async function executeReadFile(input: Record<string, unknown>, cwd: string): Promise<string> {
  const filePath = pathArg(input);
  const resolved = await resolveWorkspacePath(cwd, filePath);
  const fh = await open(resolved, 'r');
  let raw: string;
  let oversized = false;
  try {
    const st = await fh.stat();
    if (st.size > READ_BUDGET_BYTES) {
      const buf = Buffer.alloc(READ_BUDGET_BYTES);
      const { bytesRead } = await fh.read(buf, 0, READ_BUDGET_BYTES, 0);
      raw = buf.subarray(0, bytesRead).toString('utf-8');
      oversized = true;
    } else {
      raw = await fh.readFile('utf-8');
    }
  } finally {
    await fh.close();
  }

  const allLines = raw.split('\n');
  const startLine = numberArg(input, ['StartLine', 'startLine', 'start_line']);
  const endLine = numberArg(input, ['EndLine', 'endLine', 'end_line']);
  if (endLine !== undefined && endLine < 1) {
    throw new Error('read_file end_line must be >= 1');
  }
  const hasRange = [startLine, endLine].some((value) => value !== undefined);
  const start = startLine === undefined ? 1 : Math.max(1, Math.floor(startLine));
  const end = endLine === undefined ? allLines.length : Math.min(allLines.length, Math.floor(endLine));
  const maxLines = hasRange ? HARD_MAX_LINES : DEFAULT_MAX_LINES;
  let lines = allLines.slice(start - 1, end);
  let truncated = oversized;

  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }

  let content = lines.join('\n');
  if (Buffer.byteLength(content) > HARD_MAX_BYTES) {
    content = Buffer.from(content).subarray(0, HARD_MAX_BYTES).toString('utf-8');
    truncated = true;
  }

  if (!truncated) return content;
  const total = oversized ? 'file exceeds 1 MiB read budget' : `${allLines.length} lines`;
  return `${content}\n\n[Truncated at ${lines.length} lines. Total: ${total}. Use start_line/end_line for targeted reads.]`;
}

export class AntigravityIdeReadToolExecutor implements AntigravityToolExecutor<Record<string, unknown>, string> {
  constructor(readonly toolName: AntigravityIdeReadToolName) {}

  canHandle(step: TrajectoryStep): boolean {
    return resolveToolName(step) === this.toolName;
  }

  async execute(input: Record<string, unknown>, ctx: ExecutorContext): Promise<ExecutorResult<string>> {
    const startedAt = Date.now();
    let result: ExecutorResult<string>;
    try {
      const supportedReadTool = IDE_READ_TOOLS.has(this.toolName) && isReadOnlyMcpTool(this.toolName);
      if (!supportedReadTool) {
        result = { status: 'refused', reason: `Unsupported Antigravity IDE read-only tool: ${this.toolName}` };
      } else {
        let output: string;
        switch (this.toolName) {
          case 'grep_search':
            output = await executeGrepSearch(input, ctx.cwd);
            break;
          case 'list_dir':
            output = await executeListDir(input, ctx.cwd);
            break;
          case 'read_file':
          case 'view_file':
            output = await executeReadFile(input, ctx.cwd);
            break;
        }
        result = { status: 'success', output, stdout: output, durationMs: durationSince(startedAt) };
      }
    } catch (err: unknown) {
      result = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: durationSince(startedAt),
      };
    }

    await ctx.audit.record({
      tool: this.toolName,
      cascadeId: ctx.cascadeId,
      stepIndex: ctx.stepIndex,
      input,
      result,
      timestamp: new Date(),
    });
    return result;
  }
}
