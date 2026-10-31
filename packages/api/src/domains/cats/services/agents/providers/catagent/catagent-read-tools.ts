/**
 * CatAgent Read-Only Tools — F159 Phase D (AC-D1)
 *
 * Three read-only tools for workspace file operations:
 * - read_file:      read file contents (resolveSecurePath + denylist + truncation)
 * - list_files:     list directory contents (resolveSecurePath + isDenylisted filter)
 * - search_content: ripgrep search (buildSafeCommand + denylist exclude + result filter)
 *
 * ADR-001 boundary: no write/edit/delete, no shell/exec, no network tools.
 */

import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isDenylisted } from '../../../../../../domains/workspace/workspace-security.js';
import { buildSafeCommand } from './catagent-tool-guard.js';
import type { CatAgentTool, ToolSchema } from './catagent-tools.js';
import { resolveSecurePath } from './catagent-tools.js';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_LINES = 300;
const HARD_MAX_LINES = 500;
const HARD_MAX_BYTES = 32_768;
/** Max bytes buffered per read_file call — enforced BEFORE line splitting to prevent OOM. */
const READ_BUDGET_BYTES = 1_048_576; // 1 MiB
const MAX_SEARCH_RESULTS = 50;

/** Denylist globs for rg pre-filtering (isDenylisted is the authoritative filter) */
const RG_DENYLIST_GLOBS = ['!.env*', '!*.pem', '!*.key', '!id_rsa*', '!.git', '!secrets'];

// ── read_file ──

const readFileSchema: ToolSchema = {
  name: 'read_file',
  description:
    'Read a file from the workspace. Returns contents, truncated if large. Use start_line/end_line for targeted reads.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file' },
      start_line: { type: 'number', description: 'Start line (1-based, optional)' },
      end_line: { type: 'number', description: 'End line (1-based, optional)' },
    },
    required: ['path'] as const,
  },
};

async function executeReadFile(input: Record<string, unknown>, workDir: string): Promise<string> {
  const resolved = await resolveSecurePath(workDir, input.path as string);

  // Enforce read budget BEFORE line splitting to prevent OOM on large files.
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

  const hasRange = typeof input.start_line === 'number' || typeof input.end_line === 'number';
  const start = typeof input.start_line === 'number' ? Math.max(1, input.start_line) : 1;
  const end = typeof input.end_line === 'number' ? Math.min(allLines.length, input.end_line) : allLines.length;
  let lines = allLines.slice(start - 1, end);

  const maxLines = hasRange ? HARD_MAX_LINES : DEFAULT_MAX_LINES;
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

  if (truncated) {
    const total = oversized ? 'file exceeds 1 MiB read budget' : `${allLines.length} lines`;
    return `${content}\n\n[Truncated at ${lines.length} lines. Total: ${total}. Use start_line/end_line for targeted reads.]`;
  }
  return content;
}

// ── list_files ──

const listFilesSchema: ToolSchema = {
  name: 'list_files',
  description: 'List files and directories in a workspace directory. Sensitive files are filtered.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative directory path (default: ".")' },
    },
    required: [] as const,
  },
};

async function executeListFiles(input: Record<string, unknown>, workDir: string): Promise<string> {
  const dirPath = (input.path as string) || '.';
  const resolved = await resolveSecurePath(workDir, dirPath);
  const entries = await readdir(resolved, { withFileTypes: true });
  const prefix = dirPath === '.' ? '' : dirPath;

  const filtered = entries.filter((e) => !isDenylisted(join(prefix, e.name)));
  if (filtered.length === 0) return '(empty directory)';

  return filtered
    .map((e) => `${e.isDirectory() ? '[dir]  ' : '[file] '}${e.name}`)
    .sort()
    .join('\n');
}

// ── search_content ──

const searchContentSchema: ToolSchema = {
  name: 'search_content',
  description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex)' },
      path: { type: 'string', description: 'Relative path to search in (default: ".")' },
      include: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
    },
    required: ['pattern'] as const,
  },
};

let rgAvailable: boolean | null = null;

async function checkRgAvailable(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await execFileAsync('rg', ['--version']);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/** Exported for testing */
export function resetRgCache(): void {
  rgAvailable = null;
}

async function executeSearchContent(input: Record<string, unknown>, workDir: string): Promise<string> {
  if (!(await checkRgAvailable())) return 'Error: ripgrep (rg) is not installed.';

  const searchPath = (input.path as string) || '.';
  await resolveSecurePath(workDir, searchPath);

  const fixedArgs = [
    '--no-heading',
    '--line-number',
    '--color',
    'never',
    '--max-count',
    '100',
    '-e',
    input.pattern as string,
    ...RG_DENYLIST_GLOBS.flatMap((g) => ['--glob', g]),
  ];
  if (typeof input.include === 'string') fixedArgs.push('--glob', input.include);

  const [bin, args] = buildSafeCommand('rg', fixedArgs, [searchPath]);

  try {
    const { stdout } = await execFileAsync(bin, args, { cwd: workDir, timeout: 10_000, maxBuffer: 512 * 1024 });
    return filterAndTruncate(stdout);
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 1) return 'No matches found.';
    throw err;
  }
}

function filterAndTruncate(stdout: string): string {
  const lines = stdout.split('\n').filter((line) => {
    if (!line.trim()) return false;
    const sep = line.indexOf(':');
    return sep <= 0 || !isDenylisted(line.slice(0, sep));
  });
  if (lines.length === 0) return 'No matches found.';
  if (lines.length <= MAX_SEARCH_RESULTS) return lines.join('\n');
  return `${lines.slice(0, MAX_SEARCH_RESULTS).join('\n')}\n\n[Truncated: ${MAX_SEARCH_RESULTS}/${lines.length} matches shown.]`;
}

// ── Registry ──

export async function buildToolRegistry(workDir: string): Promise<CatAgentTool[]> {
  const tools: CatAgentTool[] = [
    { schema: readFileSchema, execute: (i) => executeReadFile(i, workDir), permission: 'allow' },
    { schema: listFilesSchema, execute: (i) => executeListFiles(i, workDir), permission: 'allow' },
  ];
  if (await checkRgAvailable()) {
    tools.push({ schema: searchContentSchema, execute: (i) => executeSearchContent(i, workDir), permission: 'allow' });
  }
  return tools;
}

export function getToolSchemas(tools: CatAgentTool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}

export function findTool(tools: CatAgentTool[], name: string): CatAgentTool | undefined {
  return tools.find((t) => t.schema.name === name);
}
