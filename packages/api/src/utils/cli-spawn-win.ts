/**
 * Windows CLI Spawn Helpers (#64)
 *
 * Resolves .cmd shim scripts to their underlying .js entry points
 * so we can bypass shell on Windows. Falls back to shell mode
 * with escaped arguments if resolution fails.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

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

/**
 * Parse a .cmd shim file to extract the Node.js script target path.
 *
 * npm .cmd shims have two common formats:
 *   1. `%~dp0\node_modules\pkg\cli.js` (classic, with %~dp0)
 *   2. `"%dp0%\node_modules\pkg\bin\cmd"` (newer, with %dp0% and possibly no .js extension)
 *
 * Portable Node installs may have `%~dp0\node.exe` as a prelude — we skip
 * .exe targets since those are the launcher, not the script entry point.
 *
 * Returns the first resolved non-exe path that exists on disk, or null.
 */
function parseShimScriptTarget(cmdPath: string): string | null {
  const shimContent = readFileSync(cmdPath, 'utf-8');
  const shimDir = cmdPath.replace(/[/\\][^/\\]+$/, '');

  // Match both %~dp0\ and %dp0%\ patterns. Capture the relative path after dp0 prefix.
  // The target may or may not have a .js extension (e.g. opencode uses extensionless bin).
  // We use a greedy approach: capture everything up to the next quote, %, or end-of-line,
  // then verify the path exists on disk.
  for (const match of shimContent.matchAll(/%~?dp0%?\\([^"%\r\n]+)/gi)) {
    const relPath = match[1].replace(/%\*$/g, '').trimEnd();
    // Skip .exe targets — these are the Node launcher prelude, not the script entry point.
    // Portable Node installs place node.exe alongside the shim, and the regex would match it
    // first, causing `node node.exe` (MZ SyntaxError). See #247.
    if (/\.exe$/i.test(relPath)) continue;
    const scriptPath = join(shimDir, relPath.replace(/\\/g, '/'));
    if (existsSync(scriptPath)) return scriptPath;
  }
  return null;
}

/**
 * Resolve the underlying entry script from a Windows .cmd shim.
 *
 * Strategy:
 * 1. Locate the .cmd selected by PATH via `where`, parse %dp0% relative paths
 * 2. Fall back to known paths under %APPDATA%/npm/node_modules
 * 3. Cache result (null = not resolvable, use shell fallback)
 */
export function resolveCmdShimScript(command: string): string | null {
  const cached = resolvedShimCache.get(command);
  if (cached !== undefined) {
    if (cached === null) return null;
    if (existsSync(cached)) return cached;
    resolvedShimCache.delete(command);
  }

  // Strategy 0: if command is already a full .cmd path, parse it directly
  // (resolveCliCommand may return the full path from `where`)
  if (/\.cmd$/i.test(command) && existsSync(command)) {
    const scriptPath = parseShimScriptTarget(command);
    if (scriptPath) {
      resolvedShimCache.set(command, scriptPath);
      return scriptPath;
    }
  }

  // Strategy 1: parse the .cmd shim selected by PATH via `where`
  try {
    const whereOutput = execSync(`where ${command}.cmd`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    for (const cmdPath of whereOutput.split(/\r?\n/)) {
      if (!cmdPath || !existsSync(cmdPath)) continue;
      const scriptPath = parseShimScriptTarget(cmdPath);
      if (scriptPath) {
        resolvedShimCache.set(command, scriptPath);
        return scriptPath;
      }
    }
  } catch {
    // `where` failed or timed out — fall through to shell mode
  }

  // Strategy 2: known paths as a fallback when PATH probing fails
  // Extract bare command name if command is a full path (e.g. "C:\...\codex.cmd" → "codex")
  const appData = process.env.APPDATA;
  const bareCommand = command.replace(/^.*[/\\]/, '').replace(/\.cmd$/i, '');
  const knownPaths = KNOWN_SHIM_SCRIPTS[command] ?? KNOWN_SHIM_SCRIPTS[bareCommand];
  if (appData && knownPaths) {
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
  return {
    command: process.execPath,
    args: [shimScript, ...args],
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
