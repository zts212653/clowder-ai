/**
 * Shell Tools — read-only shell exec for Bengal (F061 Bug-F workaround)
 *
 * Bengal (Antigravity) runs into UI permission gate on pwd/git/curl via cascade
 * native `run_command`. MCP stdio doesn't pass through that gate, so this tool
 * gives Bengal a whitelist-guarded escape hatch for diagnostic / read-only shell
 * commands that the Antigravity LS UI allowlist (`ls` only) doesn't cover.
 *
 * Safety (mirrors api RunCommandExecutor refusal rules):
 * - Read-only command whitelist (pwd/ls/cat/git log|status|rev-parse|diff|show)
 * - Redis 6399 sanctum refusal
 * - Fork bomb / rm -rf / refusal
 * - Shell control (|;&><) / substitution ($()/backtick) / var expansion denied
 *
 * Returns stdout/stderr/exitCode. 30s timeout. Not a general-purpose shell.
 */

import { exec } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getDefaultConfig, isPathAllowed } from '../utils/path-validator.js';
import { errorResult, successResult, type ToolResult } from './file-tools.js';

const execAsync = promisify(exec);

const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB
const TIMEOUT_MS = 30_000;

const REDIS_SANCTUM_REASON = 'Redis 6399 is user sanctum (read-only by rule)';
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /-p\s*6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /--port[=\s]+6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /rediss?:\/\/[^\s"']*:6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /\bport\s*:\s*6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, reason: 'rm -rf / is always refused' },
  { pattern: /:\(\)\{\s*:\|:/i, reason: 'fork bomb pattern refused' },
];

const SHELL_CONTROL_PATTERN = /[><|;&]/;
const SHELL_SUBSTITUTION_PATTERN = /[`]/;
const SHELL_NEWLINE_PATTERN = /[\n\r]/;
// `$` covers ALL of: $VAR / ${VAR} / $(...) / $'ANSI-C' / $"locale-translation".
// Cloud P1 round-3 (be51518f review) noted ANSI-C `$'\x2f'` decodes to `/`
// inside shell but is invisible to our static path-allow checks. Refusing
// any `$` is simpler and tighter than enumerating each form.
const SHELL_DOLLAR_PATTERN = /\$/;
// Glob metacharacters: * ? [ ] are expanded by /bin/sh before exec, so
// `cat *` reads every file in cwd — if any is a symlink pointing outside
// allowed roots (e.g. cwd/link -> /etc/hosts), the path guard sees only
// the literal `*` and lets it through. Refuse glob entirely; users with
// glob needs go through cascade run_command + UI approval.
// (codex peer review on a335d159 — 2026-04-25)
const SHELL_GLOB_PATTERN = /[*?[\]]/;
// Cloud P1 (e7889045 review): naive whitespace tokenizer cannot model /bin/sh's
// escape/quote semantics. Refuse any backslash escape (e.g. `cat \/etc/passwd`,
// shell strips the `\` → `/etc/passwd`, but our split sees `\/etc/passwd` as
// in-workspace) and any quoted span with internal whitespace (e.g.
// `cat "file with space"` — split() splits across the space and we lose the
// path identity). Both are corner cases that don't show up in normal Bengal
// usage but create real allowlist bypasses.
const SHELL_BACKSLASH_PATTERN = /\\/;
const SHELL_QUOTED_SPACE_PATTERN = /(["'])[^"'\n]*\s[^"'\n]*\1/;
// `~user/...` (tilde with username) is expanded by /bin/sh to that user's
// home directory, but unquoteAndExpandTilde only handles `~` and `~/...`.
// Without this gate, `cat ~root/.ssh/id_rsa` is path-validated as a literal
// relative token under cwd (passes), then /bin/sh resolves it to an absolute
// out-of-scope path at exec time. Refuse any `~` followed by a username
// character. Cloud codex P1 on a335d159, missed in d007449e merge.
const SHELL_TILDE_USER_PATTERN = /~[A-Za-z0-9_]/;

const READ_ONLY_PATTERNS: RegExp[] = [
  /^\s*pwd(?:\s|$)/i,
  /^\s*ls(?:\s|$)/i,
  /^\s*cat\s+[^><|;&]+$/i,
  // git whitelist: log/status/rev-parse/diff/show only (no branch/checkout/commit)
  /^\s*git\s+(log|status|rev-parse)(?:\s|$)/i,
  /^\s*git\s+diff(?:\s|$)/i,
  /^\s*git\s+show(?:\s|$)/i,
];

export function getShellExecRefusalReason(commandLine: string): string | null {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(commandLine)) return reason;
  }
  return null;
}

export function isReadOnlyShellCommand(commandLine: string): boolean {
  if (getShellExecRefusalReason(commandLine)) return false;
  if (SHELL_CONTROL_PATTERN.test(commandLine)) return false;
  if (SHELL_SUBSTITUTION_PATTERN.test(commandLine)) return false;
  if (SHELL_NEWLINE_PATTERN.test(commandLine)) return false;
  // SHELL_DOLLAR_PATTERN covers $VAR / ${VAR} / $() / $'ANSI-C' / $"locale" — all banned.
  if (SHELL_DOLLAR_PATTERN.test(commandLine)) return false;
  if (SHELL_BACKSLASH_PATTERN.test(commandLine)) return false;
  if (SHELL_QUOTED_SPACE_PATTERN.test(commandLine)) return false;
  if (SHELL_GLOB_PATTERN.test(commandLine)) return false;
  if (SHELL_TILDE_USER_PATTERN.test(commandLine)) return false;
  if (/\bgit\b/i.test(commandLine) && /(^|[\s'"]+)--output(?:=|\s|['"])/.test(commandLine)) return false;
  return READ_ONLY_PATTERNS.some((pattern) => pattern.test(commandLine.trim()));
}

/**
 * Strip outer single/double quotes and expand leading `~` (or `~user` not
 * supported). Mirrors `/bin/sh` argument parsing for path-allow-check
 * purposes — without this, `cat '/etc/hosts'` and `cat ~/secret` are passed
 * to shell as text but `path.resolve()` sees them as literal strings,
 * letting attacks slip past the path guard.
 */
function unquoteAndExpandTilde(rawToken: string): string {
  let token = rawToken;
  // Strip surrounding matching single or double quotes.
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      token = token.slice(1, -1);
    }
  }
  // Expand leading `~` to homedir. Only handles bare `~` and `~/...` (not `~user`).
  if (token === '~') {
    token = os.homedir();
  } else if (token.startsWith('~/')) {
    token = path.join(os.homedir(), token.slice(2));
  }
  return token;
}

/**
 * Scan command-line tokens for path arguments and verify each resolves
 * inside allowed roots (per `isPathAllowed`). Mirrors `file-tools.ts` so
 * `cat_cafe_shell_exec` does not widen the persistent-readonly-MCP safety
 * boundary beyond path-restricted file reads.
 *
 * Rules:
 * - Skip the command name (first token).
 * - Skip flags (start with `-`).
 * - Strip outer quotes + expand leading `~` before resolving (mirror /bin/sh).
 * - Resolve EVERY remaining token (not only slash-containing) against `cwd`
 *   and call `isPathAllowed` — needed to catch bare filenames that may be
 *   symlinks to outside-roots targets (isPathAllowed follows symlinks).
 * - Reject on any unauthorized path.
 *
 * Returns null when all paths pass; returns a reason string on first violation.
 */
export function getPathBoundaryRefusalReason(commandLine: string, cwd: string): string | null {
  // Simple whitespace tokenization — SHELL_CONTROL/SUBSTITUTION/etc. already
  // rejected earlier in isReadOnlyShellCommand, so we don't need a real shell
  // parser here.
  const tokens = commandLine.trim().split(/\s+/);
  if (tokens.length <= 1) return null;
  // Skip first token — it's the command name (pwd / ls / cat / git).
  for (let i = 1; i < tokens.length; i++) {
    const original = tokens[i];
    if (!original) continue;
    if (original.startsWith('-')) continue; // flag
    const expanded = unquoteAndExpandTilde(original);
    if (!expanded || expanded.startsWith('-')) continue;
    // Resolve every non-flag arg as a potential path. Bare filenames will
    // resolve relative to cwd and pass isPathAllowed if cwd is allowed and
    // the file (after symlink-follow) is also inside allowed roots. This
    // catches symlink-traversal attacks like `cat secret-link` where
    // `cwd/secret-link` -> `/etc/shadow`.
    const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
    if (!isPathAllowed(resolved)) {
      return `path outside allowed roots: ${original} (resolved to ${resolved})`;
    }
  }
  return null;
}

/**
 * Pick the default cwd when caller doesn't pass one.
 *
 * Antigravity spawns MCP server processes with cwd=`/`, so process.cwd() lands
 * outside ALLOWED_WORKSPACE_DIRS and every cwd-less call would self-reject.
 * Instead, prefer the first non-cat-cafe-data entry from ALLOWED_WORKSPACE_DIRS
 * (skip the cat-cafe data dir which is metadata-only, not a working repo).
 * Fall back to process.cwd() only if no workspace dir is configured (the
 * downstream guard will then reject it, which is correct).
 */
function pickDefaultCwd(): string {
  const { catCafeDir, allowedDirs } = getDefaultConfig();
  for (const dir of allowedDirs) {
    if (path.resolve(dir) !== path.resolve(catCafeDir)) return dir;
  }
  return process.cwd();
}

export const shellExecInputSchema = {
  commandLine: z.string().min(1).describe('The shell command to execute (read-only whitelist enforced)'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory (defaults to first ALLOWED_WORKSPACE_DIRS entry — typically the workspace repo root)'),
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

export async function handleShellExec(input: { commandLine: string; cwd?: string }): Promise<ToolResult> {
  const commandLine = input.commandLine.trim();
  if (!commandLine) return errorResult('commandLine is required');

  const refusalReason = getShellExecRefusalReason(commandLine);
  if (refusalReason) {
    return errorResult(`Refused: ${refusalReason}`);
  }

  if (!isReadOnlyShellCommand(commandLine)) {
    return errorResult(
      `Refused: command is not on the read-only whitelist (allowed: pwd, ls, cat, git log/status/rev-parse/diff/show). ` +
        `Shell control chars (|;&>< \`$()) and variable expansion are also denied. ` +
        `Use cascade run_command + user approval for write operations.`,
    );
  }

  // Default cwd: prefer the first allowed workspace dir over process.cwd().
  // MCP server processes are spawned by Antigravity with cwd='/' by default, so
  // process.cwd() falls outside ALLOWED_WORKSPACE_DIRS and every cwd-less call
  // would self-reject. Picking the first non-cat-cafe-data allowed dir matches
  // Bengal's actual workspace root and lets `cat_cafe_shell_exec({ commandLine })`
  // work without the caller threading cwd through every invocation.
  const cwd = input.cwd ?? pickDefaultCwd();
  const resolvedCwd = path.resolve(cwd);
  if (!isPathAllowed(resolvedCwd)) {
    return errorResult(`Refused: cwd outside allowed roots (${resolvedCwd}). See ALLOWED_WORKSPACE_DIRS env.`);
  }
  const pathRefusal = getPathBoundaryRefusalReason(commandLine, resolvedCwd);
  if (pathRefusal) {
    return errorResult(`Refused: ${pathRefusal}. Use file-tools or cascade run_command + user approval instead.`);
  }

  const t0 = Date.now();

  try {
    const { stdout, stderr } = await execAsync(commandLine, {
      cwd: resolvedCwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: '/bin/sh',
    });
    const durationMs = Date.now() - t0;
    const parts = [`Status: success`, `Exit code: 0`, `Duration: ${durationMs}ms`, `Cwd: ${resolvedCwd}`];
    if (stdout && stdout.length > 0) {
      parts.push('', '--- stdout ---', truncate(stdout, MAX_OUTPUT_BYTES));
    }
    if (stderr && stderr.length > 0) {
      parts.push('', '--- stderr ---', truncate(stderr, MAX_OUTPUT_BYTES / 2));
    }
    return successResult(parts.join('\n'));
  } catch (err) {
    const durationMs = Date.now() - t0;
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const exitCode = typeof e.code === 'number' ? e.code : -1;
    const parts = [
      `Status: ${e.killed ? 'timeout' : 'error'}`,
      `Exit code: ${exitCode}`,
      `Duration: ${durationMs}ms`,
      `Cwd: ${resolvedCwd}`,
    ];
    if (e.message) parts.push(`Error: ${e.message}`);
    if (e.stdout) parts.push('', '--- stdout ---', truncate(e.stdout, MAX_OUTPUT_BYTES));
    if (e.stderr) parts.push('', '--- stderr ---', truncate(e.stderr, MAX_OUTPUT_BYTES / 2));
    return errorResult(parts.join('\n'));
  }
}

export const shellTools = [
  {
    name: 'cat_cafe_shell_exec',
    description:
      'Run a read-only shell command (pwd/ls/cat/git log|status|rev-parse|diff|show) and return stdout/stderr/exitCode. ' +
      'Bypasses Antigravity UI permission gate (F061 Bug-F workaround). ' +
      'Write operations (rm/mv/cp/mkdir/git branch|checkout|commit/npm install/etc.) are REFUSED — use cascade run_command + user approval for those. ' +
      'Redis 6399 port is sanctum and refused. 30s timeout, 256KB output cap.',
    inputSchema: shellExecInputSchema,
    handler: handleShellExec,
  },
] as const;
