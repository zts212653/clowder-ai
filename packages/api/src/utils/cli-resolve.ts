/**
 * CLI Command Resolver
 * Resolves full paths to CLI binaries, searching common install locations
 * when the command is not in the Node.js process's PATH.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/** Common install directories for CLI tools (non-Windows). */
const UNIX_SEARCH_DIRS = ['.local/bin', '.claude/bin', '.claude/local/bin'];

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
      const lines = result.split('\n').map((l) => l.trim()).filter(Boolean);
      // On Windows, prefer the .cmd shim (more reliable for shim resolution)
      const resolved = (IS_WINDOWS && lines.find((l) => /\.cmd$/i.test(l))) || lines[0];
      resolvedCache.set(command, resolved);
      return resolved;
    }
  } catch {
    // fall through to manual search
  }

  // Search common install directories (Unix only)
  if (!IS_WINDOWS) {
    const home = process.env.HOME ?? '';
    if (home) {
      for (const dir of UNIX_SEARCH_DIRS) {
        const candidate = resolve(home, dir, command);
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
    opencode: 'npm install -g opencode',
  };
  const hint = installHints[command] ?? `install the "${command}" CLI`;
  return `${command} CLI 未找到。请先运行 \`${hint}\` 安装，再重试。`;
}
