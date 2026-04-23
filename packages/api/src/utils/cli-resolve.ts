/**
 * CLI Command Resolver
 * Resolves full paths to CLI binaries, searching common install locations
 * when the command is not in the Node.js process's PATH.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Common install directories for CLI tools (non-Windows, relative to $HOME).
 * macOS GUI apps (Electron) don't inherit the user's shell PATH, so `which`
 * misses CLIs installed via nvm / fnm / Volta / Homebrew. We probe these
 * well-known locations as a fallback.
 */
const UNIX_SEARCH_DIRS = [
  '.local/bin',
  '.claude/bin',
  '.claude/local/bin',
  '.fnm/aliases/default/bin',
  '.volta/bin',
  '.nix-profile/bin',
];

/** Discover nvm-managed Node.js bin directories under ~/.nvm/versions/node/. */
function collectNvmBinDirs(): string[] {
  const home = process.env.HOME ?? '';
  if (!home) return [];
  const nvmDir = resolve(home, '.nvm/versions/node');
  try {
    return readdirSync(nvmDir)
      .filter((d) => d.startsWith('v'))
      .map((d) => resolve(nvmDir, d, 'bin'));
  } catch {
    return [];
  }
}

const resolvedCache = new Map<string, string>();

/**
 * Resolve the full path to a CLI binary.
 * Checks PATH first, then searches common install locations on Unix.
 * Returns the full path if found, or `null` if not found anywhere.
 */
export function resolveCliCommand(command: string): string | null {
  const cached = resolvedCache.get(command);
  if (cached !== undefined) return cached;

  // Fast path: already in PATH
  try {
    const which = IS_WINDOWS ? `where ${command}` : `which ${command}`;
    const result = execSync(which, { timeout: 5000, encoding: 'utf-8' }).trim();
    if (result) {
      const lines = result
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      // On Windows, prefer the .cmd shim (more reliable for shim resolution)
      const resolved = (IS_WINDOWS && lines.find((l) => /\.cmd$/i.test(l))) || lines[0];
      resolvedCache.set(command, resolved);
      return resolved;
    }
  } catch {
    // fall through to manual search
  }

  // Search common install directories
  if (IS_WINDOWS) {
    // npm install -g puts shims in %APPDATA%\npm on Windows (default prefix).
    // On clean machines where the official Node.js installer never ran, this
    // directory is not in the system PATH — so `where` misses CLI tools that
    // were installed by the bundled npm during post-install.
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const winDirs: string[] = [];
    if (appData) winDirs.push(resolve(appData, 'npm'));
    if (localAppData) winDirs.push(resolve(localAppData, 'npm'));
    for (const dir of winDirs) {
      // Prefer .cmd shim (more reliable for resolveWindowsShimSpawn)
      const cmdCandidate = resolve(dir, `${command}.cmd`);
      if (existsSync(cmdCandidate)) {
        resolvedCache.set(command, cmdCandidate);
        return cmdCandidate;
      }
    }
  } else {
    const home = process.env.HOME ?? '';
    if (home) {
      // Static well-known directories (relative to $HOME)
      for (const dir of UNIX_SEARCH_DIRS) {
        const candidate = resolve(home, dir, command);
        if (existsSync(candidate)) {
          resolvedCache.set(command, candidate);
          return candidate;
        }
      }
      // nvm-managed Node.js versions (absolute paths)
      for (const binDir of collectNvmBinDirs()) {
        const candidate = resolve(binDir, command);
        if (existsSync(candidate)) {
          resolvedCache.set(command, candidate);
          return candidate;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve CLI command or return the bare command name as fallback.
 * Use this when you want to attempt spawn even if not found (e.g. Windows
 * where shell:true may find it via different mechanisms).
 */
export function resolveCliCommandOrBare(command: string): string {
  return resolveCliCommand(command) ?? command;
}

/**
 * Format a user-friendly install hint for a missing CLI.
 */
export function formatCliNotFoundError(command: string): string {
  const installHints: Record<string, string> = {
    claude: 'npm install -g @anthropic-ai/claude-code',
    codex: 'npm install -g @openai/codex',
    gemini: 'npm install -g @google/gemini-cli',
    kimi: 'uv tool install --python 3.13 kimi-cli',
    opencode: 'npm install -g opencode',
  };
  const hint = installHints[command] ?? `install the "${command}" CLI`;
  return `${command} CLI 未找到。请先运行 \`${hint}\` 安装，再重试。`;
}
