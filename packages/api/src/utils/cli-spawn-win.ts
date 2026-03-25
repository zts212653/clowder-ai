/**
 * Windows CLI Spawn Helpers (#64)
 *
 * Resolves .cmd shim scripts to their underlying .js entry points
 * so we can bypass shell on Windows. Falls back to shell mode
 * with escaped arguments if resolution fails.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
};

export interface WindowsShimSpawn {
  command: string;
  args: string[];
}

/**
 * Extract the bare command name from a path or command string.
 * e.g. 'C:\Users\Admin\bin\claude.cmd' → 'claude'
 *      'claude' → 'claude'
 */
function extractBareName(command: string): string {
  return basename(command).replace(/\.(cmd|exe|bat)$/i, '');
}

/**
 * Try to extract a .js entry script from a .cmd shim file by parsing its content.
 * Handles both standard npm shims (%~dp0\...) and custom shims that reference
 * npm node_modules paths directly.
 */
function parseShimFile(cmdPath: string): string | null {
  if (!existsSync(cmdPath)) return null;
  const shimContent = readFileSync(cmdPath, 'utf-8');
  const shimDir = dirname(cmdPath);

  // Pattern 1: npm standard shims — "%~dp0\..." or "%dp0\..." relative paths
  for (const match of shimContent.matchAll(/%~?dp0\\([^"\r\n]*?\.js)/gi)) {
    const scriptPath = join(shimDir, match[1].replace(/\\/g, '/'));
    if (existsSync(scriptPath)) return scriptPath;
  }

  // Pattern 2: custom shims that reference node_modules paths via env vars
  // e.g. node "%NPM_BIN%\node_modules\@anthropic-ai\claude-code\cli.js" %*
  const npmModuleMatch = shimContent.match(/node_modules[/\\]([^"'\s%]+\.js)/i);
  if (npmModuleMatch) {
    const appData = process.env.APPDATA;
    if (appData) {
      const candidate = join(appData, 'npm', 'node_modules', npmModuleMatch[1].replace(/\\/g, '/'));
      if (existsSync(candidate)) return candidate;
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
 * 1b. Otherwise locate via `where` and parse %dp0% relative paths
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

  const bareName = extractBareName(command);
  const isFullPath = /[/\\]/.test(command);

  // Strategy 1a: command is already a full .cmd path — parse it directly
  if (isFullPath && /\.cmd$/i.test(command)) {
    const result = parseShimFile(command);
    if (result) {
      resolvedShimCache.set(command, result);
      return result;
    }
  }

  // Strategy 1b: locate via `where` using the bare name
  try {
    const whereTarget = isFullPath ? bareName : command;
    const whereOutput = execSync(`where "${whereTarget}.cmd"`, {
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

  // Strategy 2: known paths using bare command name for lookup
  const appData = process.env.APPDATA;
  const knownPaths = KNOWN_SHIM_SCRIPTS[bareName];
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
