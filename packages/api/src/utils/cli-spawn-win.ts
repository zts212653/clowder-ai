/**
 * Windows CLI Spawn Helpers (#64)
 *
 * Resolves .cmd shim scripts to their underlying .js entry points
 * so we can bypass shell on Windows. Falls back to shell mode
 * with escaped arguments if resolution fails.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';

/**
 * Cache for resolved shim scripts to avoid repeated filesystem lookups.
 */
const resolvedShimCache = new Map<string, string | null>();

/**
 * Known npm-global paths for common CLI tools on Windows.
 * Checked first for fast resolution before falling back to `where`.
 */
const KNOWN_SHIM_SCRIPTS: Record<string, string[]> = {
  claude: ['@anthropic-ai/claude-code/cli.js'],
  codex: ['@openai/codex/bin/codex.js'],
  gemini: ['@google/gemini-cli/bin/gemini.js'],
  opencode: ['opencode-ai/bin/opencode'],
};

export interface WindowsShimSpawn {
  command: string;
  args: string[];
}

export type WindowsSpawnMode = 'shim' | 'native-exe' | 'git-bash' | 'cmd';

export interface WindowsSpawnPlan {
  command: string;
  args: string[];
  mode: WindowsSpawnMode;
  shell?: true | string;
}

/**
 * Extract the bare command name from a path or command string.
 * e.g. 'C:\Users\Admin\bin\claude.cmd' → 'claude'
 *      'claude' → 'claude'
 */
export function extractBareName(command: string): string {
  // Use both / and \ as separators so Windows-style paths work on Linux CI too
  const base = command.replace(/^.*[/\\]/, '');
  return base.replace(/\.(cmd|exe|bat)$/i, '');
}

/**
 * Try to extract an entry script from a .cmd shim file by parsing its content.
 * Handles both relative (%~dp0, %dp0, %dp0%) and absolute (%APPDATA%, etc.) paths.
 * Prefers .js matches, falls back to extensionless entrypoints, then native .exe entrypoints.
 */
export function parseShimFile(cmdPath: string): string | null {
  if (!existsSync(cmdPath)) return null;
  const shimContent = readFileSync(cmdPath, 'utf-8');
  const shimDir = dirname(cmdPath);

  const candidates: string[] = [];

  // Relative paths: %~dp0\..., %dp0\..., %dp0%\...
  for (const match of shimContent.matchAll(/%~?dp0%?\\([^"\r\n]+)/gi)) {
    const raw = match[1].replace(/\\/g, '/').replace(/\s+%\*.*$/, '');
    candidates.push(join(shimDir, raw));
  }

  // Absolute paths via environment variables (#284): %APPDATA%\..., %LOCALAPPDATA%\..., etc.
  for (const match of shimContent.matchAll(/%([A-Z_][A-Z0-9_]*)%\\([^"\r\n]+)/gi)) {
    if (/^~?dp0$/i.test(match[1])) continue;
    const envValue = process.env[match[1]];
    if (!envValue) continue;
    const raw = match[2].replace(/\\/g, '/').replace(/\s+%\*.*$/, '');
    candidates.push(join(envValue, raw));
  }

  for (const scriptPath of candidates) {
    if (/\.js$/i.test(scriptPath) && existsSync(scriptPath)) return scriptPath;
  }

  for (const scriptPath of candidates) {
    const tail = scriptPath.split(/[/\\]/).pop() ?? '';
    if (!/\.\w+$/i.test(tail) && !/^node(\.exe)?$/i.test(tail) && existsSync(scriptPath)) {
      return scriptPath;
    }
  }

  // Third pass: native .exe entrypoints (e.g. claude.exe in Claude Code 2.1+)
  for (const scriptPath of candidates) {
    const tail = scriptPath.split(/[/\\]/).pop() ?? '';
    if (/\.exe$/i.test(tail) && !/^node(\.exe)?$/i.test(tail) && existsSync(scriptPath)) {
      return scriptPath;
    }
  }

  return null;
}

/**
 * Resolve the underlying .js entry script from a Windows .cmd shim.
 *
 * Accepts both bare command names ('claude') and full paths
 * ('C:\Users\Admin\bin\claude.cmd') — resolveCliCommand returns full paths.
 *
 * Strategy:
 * 1a. If command is a full path to an existing .cmd file, parse it directly
 * 1b. If command is a bare name, locate via `where` and parse
 * 2. Fall back to known paths under %APPDATA%/npm/node_modules
 * 3. Cache result (null = not resolvable, use shell fallback)
 *
 * Important: when a full path is provided, we do NOT fall back to bare-name
 * `where` lookup — this avoids silently resolving to a different CLI version.
 */
export function resolveCmdShimScript(command: string): string | null {
  const cached = resolvedShimCache.get(command);
  if (cached !== undefined) {
    if (cached === null) return null;
    if (existsSync(cached)) return cached;
    resolvedShimCache.delete(command);
  }

  const bareName = extractBareName(command);
  const isFullPath = /[/\\]/.test(command);

  // Strategy 1a: command is already a full .cmd path — parse it directly
  if (isFullPath && /\.cmd$/i.test(command)) {
    const result = parseShimFile(command);
    if (result) {
      resolvedShimCache.set(command, result);
      return result;
    }
    // Full path provided but parsing failed — do NOT fall back to `where`
    // to avoid resolving to a different CLI version on PATH.
  }

  // Strategy 1b: bare command name — locate via `where`
  if (!isFullPath) {
    try {
      const whereOutput = execSync(`where "${command}.cmd"`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      for (const cmdPath of whereOutput.split(/\r?\n/)) {
        const result = parseShimFile(cmdPath.trim());
        if (result) {
          resolvedShimCache.set(command, result);
          return result;
        }
      }
    } catch {
      // `where` failed or timed out — fall through
    }
  }

  // Strategy 2: known paths — only for bare command names (not full paths,
  // which represent a caller-selected install that must not be remapped)
  const appData = process.env.APPDATA;
  const knownPaths = KNOWN_SHIM_SCRIPTS[bareName];
  if (!isFullPath && appData && knownPaths) {
    for (const relPath of knownPaths) {
      const candidate = join(appData, 'npm', 'node_modules', relPath);
      if (existsSync(candidate)) {
        resolvedShimCache.set(command, candidate);
        return candidate;
      }
    }
  }

  resolvedShimCache.set(command, null);
  return null;
}

export function resolveWindowsShimSpawn(
  command: string,
  args: readonly string[],
  shimScriptOverride?: string,
): WindowsShimSpawn | null {
  const shimScript = shimScriptOverride ?? resolveCmdShimScript(command);
  if (!shimScript) return null;
  if (/\.exe$/i.test(shimScript)) {
    return {
      command: shimScript,
      args: [...args],
    };
  }
  return {
    command: process.execPath,
    args: [shimScript, ...args],
  };
}

/**
 * Whether to spawn a Windows native .exe directly via argv (no shell).
 *
 * Recent Anthropic / Codex CLI releases ship as standalone PE32+ binaries
 * (e.g. `claude.exe` 250MB+). They have no .cmd shim parseable by
 * resolveCmdShimScript — bin/claude.exe is the entry, and the npm shim
 * (when present) just re-launches the same .exe. Falling through to the
 * Git Bash shell path passes the (potentially huge) prompt as a `-c`
 * string, where any unbalanced quote in the multi-line content triggers
 * `bash: -c: line N: unexpected EOF` (exit 2) before claude.exe even
 * starts.
 *
 * Native exe + argv mode skips shell parsing entirely — child_process
 * passes args via the Win32 CreateProcess argv array, so quoting is the
 * exe's problem (it is, in fact, well-behaved).
 */
export function shouldDirectSpawnNativeExe(
  command: string,
  options: { platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return false;
  if (!/\.exe$/i.test(command)) return false;
  const fileExists = options.exists ?? existsSync;
  return fileExists(command);
}

export function resolveWindowsSpawnPlan(command: string, args: readonly string[]): WindowsSpawnPlan {
  const shimSpawn = resolveWindowsShimSpawn(command, args);
  if (shimSpawn) {
    return {
      command: shimSpawn.command,
      args: shimSpawn.args,
      mode: 'shim',
    };
  }

  if (shouldDirectSpawnNativeExe(command)) {
    return {
      command,
      args: [...args],
      mode: 'native-exe',
    };
  }

  const gitBash = findGitBashPath();
  if (gitBash) {
    return {
      command: escapeBashArg(command),
      args: args.map(escapeBashArg),
      mode: 'git-bash',
      shell: gitBash,
    };
  }

  return {
    command: escapeCmdArg(command),
    args: args.map(escapeCmdArg),
    mode: 'cmd',
    shell: true,
  };
}

/**
 * Escape a command-line argument for Windows cmd.exe shell mode.
 *
 * Uses the MSVC C runtime escaping rules for argv parsing:
 * - Backslashes before a double quote must be doubled
 * - Trailing backslashes before the closing quote must be doubled
 * - Internal double quotes are escaped as \"
 * Then applies cmd.exe-level escaping: % doubled, metacharacters (including parentheses) caret-escaped.
 */
export function escapeCmdArg(arg: string): string {
  if (!/[\s"&|<>^%!\\()]/.test(arg)) return arg;
  // MSVC CRT escaping: process each character, tracking backslash runs
  let crtEscaped = '';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      // Double the backslashes before a quote, then emit \"
      crtEscaped += `${'\\'.repeat(backslashes * 2)}\\"`;
      backslashes = 0;
    } else {
      crtEscaped += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  // Double trailing backslashes (they'll precede the closing quote)
  crtEscaped += '\\'.repeat(backslashes * 2);
  // cmd.exe escaping on top of CRT escaping
  let escaped = crtEscaped.replace(/%/g, '%%');
  escaped = escaped.replace(/([&|<>^!()])/g, '^$1');
  return `"${escaped}"`;
}

/**
 * Escape a command-line argument for bash (Git Bash on Windows).
 * Single-quote wrapping with internal single-quote escaping.
 */
export function escapeBashArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ── Git Bash detection (shared across spawn & agent services) ──

const IS_WINDOWS = process.platform === 'win32';

let cachedGitBashPath: string | undefined | null;

function isWindowsSystemBash(candidate: string): boolean {
  const normalized = win32.normalize(candidate).toLowerCase();
  return normalized.endsWith('\\system32\\bash.exe');
}

export function pickGitBashPathFromWhere(whereOutput: string, pathExists = existsSync): string | undefined {
  const existingCandidates: string[] = [];
  for (const rawLine of whereOutput.split(/\r?\n/)) {
    const candidate = rawLine.trim().replace(/^"+|"+$/g, '');
    if (!candidate) continue;
    if (win32.basename(candidate).toLowerCase() !== 'bash.exe') continue;
    if (!pathExists(candidate)) continue;
    existingCandidates.push(candidate);
  }

  for (const candidate of existingCandidates) {
    if (!isWindowsSystemBash(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function findGitBashPath(): string | undefined {
  if (!IS_WINDOWS) return undefined;
  if (cachedGitBashPath !== undefined) return cachedGitBashPath ?? undefined;

  const standardPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (existsSync(standardPath)) {
    cachedGitBashPath = standardPath;
    return standardPath;
  }

  try {
    const whereOutput = execSync('where bash', { encoding: 'utf-8', timeout: 5000 }).trim();
    const discoveredPath = pickGitBashPathFromWhere(whereOutput);
    if (discoveredPath) {
      cachedGitBashPath = discoveredPath;
      return discoveredPath;
    }
  } catch {
    // `where` failed
  }

  cachedGitBashPath = null;
  return undefined;
}
