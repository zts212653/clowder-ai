/**
 * CatAgent Read-Only Tools — F159 Phase D (AC-D1)
 *
 * Three read-only tools for workspace file operations:
 * - read_file:      read file contents (resolveSecurePath + denylist + truncation)
 * - list_files:     list directory contents (resolveSecurePath + isDenylisted filter)
 * - search_content: ripgrep search (buildSafeCommand + denylist exclude + result filter)
 *
 * Phase F adds gated side-effect tools:
 * - L1: write_file / patch_file
 * - L2: run_command with allowlist-first commandPolicy
 * - F3-min: update_current_task_status host-native scoped callback
 */

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import type { CommandPolicyEntry, TaskStatus } from '@cat-cafe/shared';
import { containsProtectedSegment, isDenylisted } from '../../../../../../domains/workspace/workspace-security.js';
import { buildSafeCommand } from './catagent-tool-guard.js';
import type {
  CatAgentTool,
  CatAgentToolAuditEvent,
  CatAgentToolRegistryOptions,
  ToolSchema,
} from './catagent-tools.js';
import { resolveCreatePath, resolveSecurePath } from './catagent-tools.js';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_LINES = 300;
const HARD_MAX_LINES = 500;
const HARD_MAX_BYTES = 32_768;
/** Max bytes buffered per read_file call — enforced BEFORE line splitting to prevent OOM. */
const READ_BUDGET_BYTES = 1_048_576; // 1 MiB
const MAX_SEARCH_RESULTS = 50;
const MAX_WRITE_BYTES = 256 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_KILL_GRACE_MS = 3_000;
const COMMAND_MAX_BUFFER = 512 * 1024;
const IS_WINDOWS = process.platform === 'win32';
const LEVEL_RANK = { L0: 0, L1: 1, L2: 2 } as const;
const TASK_STATUSES = new Set<TaskStatus>(['todo', 'doing', 'blocked', 'done']);

/**
 * Per-path async mutex for write_file / patch_file.
 *
 * Ensures that the read → hash-check → rename sequence for a given resolved
 * path is serialized, preventing the concurrent-CAS TOCTOU where two patches
 * with the same expected_hash both pass and the later rename silently
 * overwrites the earlier edit.
 */
const pathLocks = new Map<string, Promise<void>>();

async function canonicalPathLockKey(resolvedPath: string): Promise<string> {
  let ancestor = resolvedPath;
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return join(canonicalAncestor, ...missingSegments.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw err;
      missingSegments.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function withPathLock<T>(resolvedPath: string, fn: () => Promise<T>): Promise<T> {
  // Canonicalize the target (or its nearest existing ancestor for new files)
  // so in-workspace symlink aliases cannot acquire independent CAS locks for
  // the same underlying file.
  const lockKey = await canonicalPathLockKey(resolvedPath);
  // Wait for any in-flight operation on this path to finish.
  while (pathLocks.has(lockKey)) {
    await pathLocks.get(lockKey);
  }
  let releaseLock!: () => void;
  const lock = new Promise<void>((r) => {
    releaseLock = r;
  });
  pathLocks.set(lockKey, lock);
  try {
    return await fn();
  } finally {
    pathLocks.delete(lockKey);
    releaseLock();
  }
}

/** Denylist globs for rg pre-filtering via --iglob (case-insensitive; isDenylisted is the authoritative filter) */
const RG_DENYLIST_GLOBS = ['!.env*', '!*.pem', '!*.key', '!id_rsa*', '!.git', '!secrets'];

/** Exported for testing: the deny globs constant */
export const RG_DENYLIST_GLOBS_FOR_TEST = RG_DENYLIST_GLOBS;

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
    '--no-config',
    '--no-heading',
    '--line-number',
    '--color',
    'never',
    '--max-count',
    '100',
    '-e',
    input.pattern as string,
    ...RG_DENYLIST_GLOBS.flatMap((g) => ['--iglob', g]),
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

// ── write_file / patch_file ──

const writeFileSchema: ToolSchema = {
  name: 'write_file',
  description: 'Write a UTF-8 file within the workspace using an atomic tmp+rename operation. Max 256 KiB.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to write' },
      content: {
        type: 'string',
        description: 'Full file content (empty string = create empty file)',
        allowEmpty: true,
      },
    },
    required: ['path', 'content'] as const,
  },
};

const patchFileSchema: ToolSchema = {
  name: 'patch_file',
  description:
    'Patch a workspace file by replacing one unique old_text occurrence after expected_hash compare-and-swap.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to patch' },
      old_text: {
        type: 'string',
        description: 'Text that must match exactly once (whitespace-only spans are valid targets)',
        allowEmpty: true,
      },
      new_text: { type: 'string', description: 'Replacement text (empty string = deletion)', allowEmpty: true },
      expected_hash: { type: 'string', description: 'SHA-256 hash or prefix of the current file content' },
    },
    required: ['path', 'old_text', 'new_text', 'expected_hash'] as const,
  },
};

function hashContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizedRel(workDir: string, resolvedPath: string): string {
  return relative(workDir, resolvedPath).replace(/\\/g, '/');
}

async function emitAudit(options: CatAgentToolRegistryOptions, event: CatAgentToolAuditEvent): Promise<void> {
  await options.audit?.(event);
}

/**
 * Run a mutation, then emit audit.  If the mutation succeeds but audit fails,
 * log the audit failure and return a success result annotated with
 * "[audit-degraded]" — because the side-effect already committed and returning
 * an error would be a false failure that invites unsafe retries.
 *
 * Callers pass:
 *   mutate()  → performs the irreversible side-effect
 *   auditEvent → the structured audit record (outcome will be forced to 'ok')
 *   successMessage → the tool output returned to the model on happy path
 */
async function commitThenAudit(
  options: CatAgentToolRegistryOptions,
  mutate: () => void | Promise<void>,
  auditEvent: Omit<CatAgentToolAuditEvent, 'outcome' | 'timestamp'>,
  successMessage: string,
): Promise<string> {
  await mutate();
  try {
    await emitAudit(options, { ...auditEvent, outcome: 'ok', timestamp: Date.now() });
  } catch (auditErr) {
    // Mutation committed — returning an error here would be a lie.
    // Log so ops can reconcile, return success with degradation note.
    // No structured logger in this module — stderr is the best-effort durable channel.
    // eslint-disable-next-line no-console
    console.error('[catagent-read-tools] audit emit failed after committed mutation', auditEvent.tool, auditErr);
    return `${successMessage} [audit-degraded: audit sink unavailable]`;
  }
  return successMessage;
}

async function rejectWithAudit(
  options: CatAgentToolRegistryOptions,
  event: Omit<CatAgentToolAuditEvent, 'outcome' | 'timestamp'>,
  message: string,
): Promise<never> {
  await emitAudit(options, { ...event, outcome: 'rejected', rejectReason: message, timestamp: Date.now() });
  throw new Error(message);
}

/**
 * Wrap resolveCreatePath with audited rejection so path-resolution failures
 * (traversal, denylist) produce a CATAGENT_SIDE_EFFECT audit record using the
 * original user-supplied path.
 */
async function resolveCreatePathAudited(
  workDir: string,
  rawPath: string,
  tool: CatAgentToolAuditEvent['tool'],
  options: CatAgentToolRegistryOptions,
): Promise<string> {
  try {
    return await resolveCreatePath(workDir, rawPath);
  } catch (err) {
    return rejectWithAudit(options, { tool, path: rawPath }, (err as Error).message);
  }
}

/**
 * Wrap resolveSecurePath with audited rejection for patch_file path-resolution
 * failures.
 */
async function resolveSecurePathAudited(
  workDir: string,
  rawPath: string,
  tool: CatAgentToolAuditEvent['tool'],
  options: CatAgentToolRegistryOptions,
): Promise<string> {
  try {
    return await resolveSecurePath(workDir, rawPath);
  } catch (err) {
    return rejectWithAudit(options, { tool, path: rawPath }, (err as Error).message);
  }
}

async function existingFileHash(resolvedPath: string): Promise<string | null> {
  try {
    const st = await lstat(resolvedPath);
    if (st.isSymbolicLink()) throw new Error('Refusing to overwrite symlink path');
    if (!st.isFile()) throw new Error('Refusing to overwrite non-regular file (directory, FIFO, socket, or device)');
    return hashContent(await readFile(resolvedPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Reject before an unbounded read of a large pre-existing file.
 *
 * Both write_file and patch_file hash the *current* file contents (whole-file
 * read) before writing. Without this guard an L1 CatAgent could point a tiny
 * write/patch at a multi-GB workspace file and exhaust the API process, since
 * the 256 KiB cap only bounds the *new* content, not the old-file read.
 */
async function assertWithinWriteCap(
  resolvedPath: string,
  relPath: string,
  tool: CatAgentToolAuditEvent['tool'],
  options: CatAgentToolRegistryOptions,
): Promise<void> {
  let size: number;
  try {
    const st = await lstat(resolvedPath);
    // Non-regular files (symlink/dir): write_file rejects symlinks downstream
    // via existingFileHash; patch_file rejects them inline before readFile.
    // Only regular files get read for hashing.
    if (!st.isFile()) return;
    size = st.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (size > MAX_WRITE_BYTES) {
    await rejectWithAudit(
      options,
      { tool, path: relPath, bytes: size },
      `existing file (${size} bytes) exceeds write cap (${MAX_WRITE_BYTES} bytes); refusing to read for hashing`,
    );
  }
}

async function writeAtomicUtf8(resolvedPath: string, content: string): Promise<void> {
  const parent = dirname(resolvedPath);
  await mkdir(parent, { recursive: true });
  // Preserve an existing regular file's permission bits across the temp+rename.
  // A fresh temp file is created with default perms, so without this an
  // executable script (e.g. scripts/*.sh) silently loses its +x bit after a patch.
  let existingMode: number | undefined;
  try {
    const st = await lstat(resolvedPath);
    if (st.isFile()) existingMode = st.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmpPath = join(parent, `.catagent-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
    if (existingMode !== undefined) await chmod(tmpPath, existingMode);
    await rename(tmpPath, resolvedPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

async function executeWriteFile(
  input: Record<string, unknown>,
  workDir: string,
  options: CatAgentToolRegistryOptions,
): Promise<string> {
  const content = input.content as string;
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_WRITE_BYTES) {
    await rejectWithAudit(
      options,
      { tool: 'write_file', path: input.path as string, bytes },
      'write_file exceeds 256 KiB',
    );
  }

  const resolved = await resolveCreatePathAudited(workDir, input.path as string, 'write_file', options);
  const relPath = normalizedRel(workDir, resolved);

  return withPathLock(resolved, async () => {
    // Reject non-regular files with audit before hashing — parity with
    // patch_file (which uses rejectWithAudit for the same policy). Plain
    // throws in existingFileHash bypass audit records (Codex R5 P2).
    try {
      const preSt = await lstat(resolved);
      if (preSt.isSymbolicLink()) {
        await rejectWithAudit(options, { tool: 'write_file', path: relPath }, 'write_file refuses to follow symlinks');
      }
      if (!preSt.isFile()) {
        await rejectWithAudit(
          options,
          { tool: 'write_file', path: relPath },
          'write_file refuses non-regular files (directory, FIFO, socket, or device)',
        );
      }
    } catch (err) {
      // ENOENT is fine — file doesn't exist yet. rejectWithAudit throws
      // a CatAgentToolRejection that must propagate.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await assertWithinWriteCap(resolved, relPath, 'write_file', options);
    const hashBefore = await existingFileHash(resolved);
    const hashAfter = hashContent(content);
    return commitThenAudit(
      options,
      () => writeAtomicUtf8(resolved, content),
      { tool: 'write_file', path: relPath, bytes, hashBefore, hashAfter },
      `Wrote ${bytes} bytes to ${relPath} (sha256:${hashAfter.slice(0, 12)})`,
    );
  });
}

interface TextSpanMatch {
  start: number;
  end: number;
  matches: number;
}

function findUniqueTextSpan(haystack: string, needle: string): TextSpanMatch {
  if (needle.length === 0) return { start: -1, end: -1, matches: 0 };
  let count = 0;
  let first = -1;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    if (first === -1) first = idx;
    if (count > 1) break;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return { start: first, end: first + needle.length, matches: count };
}

function replaceTextSpan(haystack: string, span: TextSpanMatch, replacement: string): string {
  return `${haystack.slice(0, span.start)}${replacement}${haystack.slice(span.end)}`;
}

async function executePatchFile(
  input: Record<string, unknown>,
  workDir: string,
  options: CatAgentToolRegistryOptions,
): Promise<string> {
  const resolved = await resolveSecurePathAudited(workDir, input.path as string, 'patch_file', options);
  const relPath = normalizedRel(workDir, resolved);
  const oldText = input.old_text as string;
  const newText = input.new_text as string;
  const expectedHash = input.expected_hash as string;
  if (expectedHash.length < 8) {
    await rejectWithAudit(options, { tool: 'patch_file', path: relPath }, 'expected_hash must be at least 8 hex chars');
  }

  return withPathLock(resolved, async () => {
    await assertWithinWriteCap(resolved, relPath, 'patch_file', options);

    // patch_file does not go through existingFileHash (which rejects symlinks
    // for write_file); reject explicitly to prevent the byte-cap bypass and
    // symlink replacement that writeAtomicUtf8's temp+rename would cause.
    try {
      const pathStat = await lstat(resolved);
      if (pathStat.isSymbolicLink()) {
        await rejectWithAudit(options, { tool: 'patch_file', path: relPath }, 'patch_file refuses to follow symlinks');
      }
      if (!pathStat.isFile()) {
        await rejectWithAudit(
          options,
          { tool: 'patch_file', path: relPath },
          'patch_file refuses non-regular files (directory, FIFO, socket, or device)',
        );
      }
    } catch (err) {
      // ENOENT means the file doesn't exist; readFile below will throw a clear
      // error. Everything else (including rejectWithAudit's throw) must propagate.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const before = await readFile(resolved, 'utf-8');
    const hashBefore = hashContent(before);
    if (!hashBefore.startsWith(expectedHash)) {
      await rejectWithAudit(options, { tool: 'patch_file', path: relPath, hashBefore }, 'expected_hash mismatch');
    }
    const span = findUniqueTextSpan(before, oldText);
    if (span.matches !== 1) {
      await rejectWithAudit(
        options,
        { tool: 'patch_file', path: relPath, hashBefore },
        `old_text must match exactly once (found ${span.matches})`,
      );
    }

    const after = replaceTextSpan(before, span, newText);
    const afterBytes = Buffer.byteLength(after, 'utf-8');
    if (afterBytes > MAX_WRITE_BYTES) {
      await rejectWithAudit(
        options,
        { tool: 'patch_file', path: relPath, bytes: afterBytes },
        `patch result (${afterBytes} bytes) exceeds write cap (${MAX_WRITE_BYTES} bytes)`,
      );
    }
    const hashAfter = hashContent(after);
    return commitThenAudit(
      options,
      () => writeAtomicUtf8(resolved, after),
      { tool: 'patch_file', path: relPath, bytes: Buffer.byteLength(after, 'utf-8'), hashBefore, hashAfter },
      `Patched ${relPath} (sha256:${hashBefore.slice(0, 12)} -> ${hashAfter.slice(0, 12)})`,
    );
  });
}

// ── run_command ──

const runCommandSchema: ToolSchema = {
  name: 'run_command',
  description: 'Run one allowlisted command with structured argv. No shell, cwd locked to workspace.',
  input_schema: {
    type: 'object',
    properties: {
      binary: { type: 'string', description: 'Command binary exactly matching commandPolicy.binary' },
      args: { type: 'array', description: 'Argument vector. String command lines are not accepted.' },
    },
    required: ['binary', 'args'] as const,
  },
};

function compilePolicyPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error(`Invalid commandPolicy allowedArgPattern: ${pattern}`);
  }
}

function isAllowedByPatterns(value: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => compilePolicyPattern(pattern).test(value));
}

function findCommandPolicyEntry(binary: string, policy: readonly CommandPolicyEntry[] | undefined): CommandPolicyEntry {
  if (!policy || policy.length === 0) throw new Error('No command policy configured');
  const entry = policy.find((p) => p.binary === binary);
  if (!entry) throw new Error(`Command binary "${binary}" is not allowed by command policy`);
  return entry;
}

function assertCommandArgsSafe(args: readonly string[], entry: CommandPolicyEntry): void {
  const denied = new Set(entry.deniedFlags ?? []);
  for (const arg of args) {
    if (arg.includes('\0')) throw new Error('Command args must not contain NUL bytes');
    if (denied.has(arg)) throw new Error(`Command flag "${arg}" is denied by command policy`);
  }
}

function assertAllowedSubcommand(args: readonly string[], entry: CommandPolicyEntry): void {
  const allowedSubcommands = entry.allowedSubcommands ?? [];
  if (allowedSubcommands.length === 0) return;
  const subcommand = args[0];
  if (!subcommand || subcommand.startsWith('-') || !allowedSubcommands.includes(subcommand)) {
    throw new Error(`Command subcommand "${subcommand ?? '<missing>'}" is not allowed by command policy`);
  }
}

function assertAllowedCommandArg(arg: string, index: number, entry: CommandPolicyEntry): void {
  if (index === 0 && (entry.allowedSubcommands ?? []).includes(arg)) return;
  if (arg.startsWith('-')) {
    if (!(entry.allowedFlags ?? []).includes(arg)) {
      throw new Error(`Command flag "${arg}" is not allowed by command policy`);
    }
    return;
  }
  if (!isAllowedByPatterns(arg, entry.allowedArgPatterns)) {
    throw new Error(`Command arg "${arg}" is not allowed by command policy`);
  }
}

function validateCommandPolicy(
  binary: string,
  args: readonly string[],
  policy: readonly CommandPolicyEntry[] | undefined,
): CommandPolicyEntry {
  const entry = findCommandPolicyEntry(binary, policy);
  assertCommandArgsSafe(args, entry);
  assertAllowedSubcommand(args, entry);
  for (const [index, arg] of args.entries()) {
    assertAllowedCommandArg(arg, index, entry);
  }
  return entry;
}

function constrainedCommandEnv(): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {}),
  };
}

function formatCommandOutput(exitCode: number | null, stdout: string, stderr: string): string {
  const parts = [`exitCode: ${exitCode ?? 'signal'}`];
  if (stdout) parts.push('', 'stdout:', stdout.trimEnd());
  if (stderr) parts.push('', 'stderr:', stderr.trimEnd());
  return parts.join('\n');
}

interface StrictCommandResult {
  stdout: string;
  stderr: string;
}

interface StrictCommandError extends Error {
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Destroy a child's stdio pipes so the close event fires promptly
 * even if grandchild processes inherited and still hold those pipes open.
 * Without this, a timed-out command whose child spawns long-lived
 * descendants can hang the tool call indefinitely.
 */
function destroyChildPipes(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

/**
 * Terminate the whole command tree.
 *
 * POSIX commands are process-group leaders (`detached: true`), so a negative
 * PID reaches every descendant in that group. Windows uses taskkill /T, with
 * /F for the SIGKILL escalation. A direct-child signal is only a fallback
 * when group/tree termination cannot be started.
 */
function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;

  if (IS_WINDOWS) {
    try {
      const args = ['/T', ...(signal === 'SIGKILL' ? ['/F'] : []), '/PID', String(pid)];
      const taskkill = execFile('taskkill', args, { windowsHide: true }, (err) => {
        if (!err) return;
        try {
          child.kill(signal);
        } catch {
          // The direct child already exited.
        }
      });
      taskkill.unref();
      return;
    } catch {
      // Fall through to direct-child signaling.
    }
  } else {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group may already be gone; direct-child signaling is a fallback.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The child already exited.
  }
}

function spawnFileWithStrictTermination(
  binary: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    killGraceMs: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<StrictCommandResult> {
  if (options.signal?.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    let termination: 'timeout' | 'abort' | 'maxBuffer' | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let spawnError: Error | undefined;
    let bufferError: StrictCommandError | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: !IS_WINDOWS,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const beginTermination = (reason: 'timeout' | 'abort' | 'maxBuffer'): void => {
      if (termination !== undefined) return;
      termination = reason;
      signalProcessTree(child, 'SIGTERM');
      killHandle = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL');
        // Close inherited pipes after escalation so spawn settles even if
        // a descendant escaped the tree-kill mechanism.
        destroyChildPipes(child);
        killHandle = undefined;
      }, options.killGraceMs);
      killHandle.unref?.();
    };

    const onAbort = (): void => beginTermination('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (bufferError) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextBytes = (stream === 'stdout' ? stdoutBytes : stderrBytes) + buffer.length;
      if (nextBytes > options.maxBuffer) {
        bufferError = Object.assign(new Error(`${stream} maxBuffer length exceeded`), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }) as StrictCommandError;
        beginTermination('maxBuffer');
        return;
      }
      if (stream === 'stdout') {
        stdoutBytes = nextBytes;
        stdoutChunks.push(buffer);
      } else {
        stderrBytes = nextBytes;
        stderrChunks.push(buffer);
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => capture('stderr', chunk));
    child.once('error', (err) => {
      spawnError = err;
    });
    child.once('close', (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);
      // Keep the escalation timer alive after forced termination even if the
      // direct child exits first: descendants may still ignore SIGTERM.
      if (killHandle && termination === undefined) clearTimeout(killHandle);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (termination === 'abort') {
        reject(createAbortError());
        return;
      }
      if (termination === 'timeout') {
        const error = new Error(`Command timed out after ${options.timeoutMs}ms`) as StrictCommandError;
        error.stdout = stdout;
        error.stderr = stderr;
        error.timedOut = true;
        reject(error);
        return;
      }
      if (bufferError) {
        bufferError.stdout = stdout;
        bufferError.stderr = stderr;
        reject(bufferError);
        return;
      }
      if (spawnError) {
        const error = spawnError as StrictCommandError;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(
          signal ? `Command terminated by ${signal}` : `Command exited with code ${code ?? 'unknown'}`,
        ) as StrictCommandError;
        error.code = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });

    timeoutHandle = setTimeout(() => {
      beginTermination('timeout');
    }, options.timeoutMs);
    timeoutHandle.unref?.();
  });
}

async function resolvePolicyEntry(
  binary: string,
  args: readonly string[],
  options: CatAgentToolRegistryOptions,
): Promise<CommandPolicyEntry> {
  try {
    return validateCommandPolicy(binary, args, options.commandPolicy);
  } catch (err) {
    await rejectWithAudit(options, { tool: 'run_command', binary, args }, (err as Error).message);
    throw err;
  }
}

async function executeRunCommand(
  input: Record<string, unknown>,
  workDir: string,
  options: CatAgentToolRegistryOptions,
): Promise<string> {
  const binary = input.binary as string;
  const rawArgs = input.args as unknown[];
  if (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== 'string')) {
    await rejectWithAudit(options, { tool: 'run_command', binary }, 'run_command args must be an array of strings');
  }
  const args = rawArgs as string[];
  const policyEntry = await resolvePolicyEntry(binary, args, options);

  const startedAt = Date.now();
  const timeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const killGrace = options.commandKillGraceMs ?? DEFAULT_COMMAND_KILL_GRACE_MS;
  try {
    const { stdout, stderr } = await spawnFileWithStrictTermination(binary, args, {
      cwd: workDir,
      timeoutMs: timeout,
      killGraceMs: killGrace,
      maxBuffer: COMMAND_MAX_BUFFER,
      env: constrainedCommandEnv(),
      signal: options.signal,
    });
    // Command already executed (non-idempotent side-effect committed) —
    // use commitThenAudit so audit failure doesn't falsely report tool error.
    const successMessage = formatCommandOutput(0, stdout, stderr);
    return commitThenAudit(
      options,
      () => {}, // mutation already committed (command ran)
      {
        tool: 'run_command',
        binary,
        args,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        policyEntry: policyEntry.binary,
      },
      successMessage,
    );
  } catch (err) {
    if (isAbortError(err)) {
      await emitAudit(options, {
        tool: 'run_command',
        outcome: 'error',
        timestamp: Date.now(),
        binary,
        args,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        policyEntry: policyEntry.binary,
        rejectReason: 'invocation aborted; terminated command process tree',
      });
      throw err;
    }
    const e = err as StrictCommandError;
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    const timedOut = e.timedOut === true;
    const exitCode = typeof e.code === 'number' ? e.code : null;
    // Command already ran (non-idempotent side-effect committed) — audit
    // failure must not mask the real command outcome, same as the success path.
    let auditDegraded = false;
    try {
      await emitAudit(options, {
        tool: 'run_command',
        outcome: 'error',
        timestamp: Date.now(),
        binary,
        args,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        policyEntry: policyEntry.binary,
        rejectReason: timedOut ? `timed out after ${timeout}ms; sent SIGTERM then SIGKILL` : e.message,
      });
    } catch (auditErr) {
      auditDegraded = true;
      // eslint-disable-next-line no-console
      console.error('[catagent-read-tools] audit emit failed after command error', binary, auditErr);
    }
    const degradedSuffix = auditDegraded ? ' [audit-degraded]' : '';
    if (timedOut) {
      throw new Error(`Command timed out after ${timeout}ms${degradedSuffix}`);
    }
    throw new Error(`${formatCommandOutput(exitCode, stdout, stderr)}${degradedSuffix}`);
  }
}

// ── update_current_task_status ──

const updateCurrentTaskStatusSchema: ToolSchema = {
  name: 'update_current_task_status',
  description: 'Update the current task status/progress/summary. Scoped to the current invocation and current task.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Task status: todo, doing, blocked, or done' },
      progress: { type: 'number', description: 'Progress percentage, 0-100' },
      summary: { type: 'string', description: 'Short task progress summary' },
    },
    required: [] as const,
  },
};

async function executeUpdateCurrentTaskStatus(
  input: Record<string, unknown>,
  options: CatAgentToolRegistryOptions,
): Promise<string> {
  const currentTask = options.scopedCallbacks?.currentTask;
  if (!currentTask) throw new Error('No current task is bound for this invocation');

  // Shared audit fields for rejection audit (AC-F13d: callback tools must
  // produce independent structured audit even on validation failure).
  const auditBase = {
    tool: 'update_current_task_status' as const,
    invocationId: currentTask.invocationId,
    currentTaskId: currentTask.currentTaskId,
  };

  const patch: { status?: TaskStatus; progress?: number; summary?: string } = {};
  if (input.status !== undefined) {
    if (!TASK_STATUSES.has(input.status as TaskStatus)) {
      return rejectWithAudit(options, auditBase, `Unsupported task status "${input.status}"`);
    }
    patch.status = input.status as TaskStatus;
  }
  if (input.progress !== undefined) {
    const progress = input.progress as number;
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      return rejectWithAudit(options, auditBase, 'progress must be a finite number between 0 and 100');
    }
    patch.progress = progress;
  }
  if (input.summary !== undefined) {
    const summary = (input.summary as string).trim();
    if (!summary || summary.length > 500) {
      return rejectWithAudit(options, auditBase, 'summary must be 1-500 characters');
    }
    patch.summary = summary;
  }
  const changedFields = Object.keys(patch);
  if (changedFields.length === 0) {
    return rejectWithAudit(options, auditBase, 'At least one of status, progress, or summary is required');
  }

  return commitThenAudit(
    options,
    () => currentTask.updateCurrentTaskStatus(patch),
    { ...auditBase, changedFields },
    `Updated current task ${currentTask.currentTaskId}: ${changedFields.join(', ')}`,
  );
}

// ── Registry ──

function levelAtLeast(level: CatAgentToolRegistryOptions['nativeToolLevel'], required: 'L1' | 'L2'): boolean {
  return LEVEL_RANK[level ?? 'L0'] >= LEVEL_RANK[required];
}

export async function buildToolRegistry(
  workDir?: string,
  options: CatAgentToolRegistryOptions = {},
): Promise<CatAgentTool[]> {
  const tools: CatAgentTool[] = [];

  // Defense-in-depth: refuse to register ANY tools when the workspace root
  // itself is inside a protected namespace. A protected root makes the segment
  // denylist ineffective because relative paths from it have no protected segment.
  // Resolve realpath to catch symlink aliases (safe-link → .cat-cafe).
  if (workDir) {
    let canonicalWorkDir: string;
    try {
      canonicalWorkDir = await realpath(workDir);
    } catch {
      canonicalWorkDir = workDir; // non-existent root: fall through to lexical check
    }
    const protectedSeg = containsProtectedSegment(canonicalWorkDir);
    if (protectedSeg) {
      await options.audit?.({
        tool: 'buildToolRegistry',
        outcome: 'rejected',
        rejectReason: `workspace root contains protected segment "${protectedSeg}"`,
        timestamp: Date.now(),
      } as CatAgentToolAuditEvent);
      return tools; // empty — no tools registered
    }
  }

  if (workDir) {
    tools.push(
      { schema: readFileSchema, execute: (i) => executeReadFile(i, workDir), permission: 'allow' },
      { schema: listFilesSchema, execute: (i) => executeListFiles(i, workDir), permission: 'allow' },
    );
  }
  if (workDir && (await checkRgAvailable())) {
    tools.push({ schema: searchContentSchema, execute: (i) => executeSearchContent(i, workDir), permission: 'allow' });
  }
  if (workDir && levelAtLeast(options.nativeToolLevel, 'L1')) {
    tools.push(
      { schema: writeFileSchema, execute: (i) => executeWriteFile(i, workDir, options), permission: 'allow' },
      { schema: patchFileSchema, execute: (i) => executePatchFile(i, workDir, options), permission: 'allow' },
    );
  }
  if (workDir && levelAtLeast(options.nativeToolLevel, 'L2')) {
    tools.push({
      schema: runCommandSchema,
      execute: (i) => executeRunCommand(i, workDir, options),
      permission: 'allow',
    });
  }
  // Gate task-status mutation on L1+ — L0 is read-only and should not gain
  // host mutation access merely because a task scope was available (Codex R5 P2).
  if (options.scopedCallbacks?.currentTask && levelAtLeast(options.nativeToolLevel, 'L1')) {
    tools.push({
      schema: updateCurrentTaskStatusSchema,
      execute: (i) => executeUpdateCurrentTaskStatus(i, options),
      permission: 'allow',
    });
  }
  return tools;
}

export function getToolSchemas(tools: CatAgentTool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}

export function findTool(tools: CatAgentTool[], name: string): CatAgentTool | undefined {
  return tools.find((t) => t.schema.name === name);
}
