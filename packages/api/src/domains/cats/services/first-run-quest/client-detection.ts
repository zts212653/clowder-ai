/**
 * F171: Detect which agent CLI clients are installed on the user's machine.
 * Only returns clients that are actually available for binding.
 *
 * LL-055 (src extension): never spawn agent runtimes for detection. Use
 * existence probes (`which`/`where`) only. Reason: complex CLIs like
 * `opencode` boot a full agent process for `opencode version`, ignore
 * SIGTERM on `exec` timeout, and macOS lacks PR_SET_PDEATHSIG so the
 * orphaned child burns CPU forever (PPID=1, ~67% CPU per leak observed
 * 2026-05-08). PATH probes can't spawn anything we have to babysit.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DetectedClient {
  /** Client ID — the CLI tool identity (claude, codex, gemini, opencode, dare, kimi) */
  client: 'claude' | 'codex' | 'gemini' | 'opencode' | 'dare' | 'kimi';
  /** Provider key matching ClientValue in hub-cat-editor (anthropic, openai, etc.) */
  provider: 'anthropic' | 'openai' | 'google' | 'opencode' | 'dare' | 'kimi';
  /** Human-readable label */
  label: string;
  /** CLI binary name */
  cli: string;
  /** Whether the CLI binary is found in PATH */
  installed: boolean;
  /**
   * Reserved field — historically held the CLI's `--version` output but that probe
   * was removed (see LL-055 src extension). Always undefined now; kept for frontend
   * type compat (ClientStep renders `{c.version && <span>v{version}</span>}` so
   * undefined naturally hides the line).
   */
  version?: string;
  /** Whether an API key env var is set for this provider */
  hasApiKey: boolean;
}

interface CliSpec {
  client: DetectedClient['client'];
  provider: DetectedClient['provider'];
  label: string;
  cli: string;
  envKey: string;
}

const CLI_SPECS: CliSpec[] = [
  { client: 'claude', provider: 'anthropic', label: 'Claude', cli: 'claude', envKey: 'ANTHROPIC_API_KEY' },
  { client: 'codex', provider: 'openai', label: 'Codex', cli: 'codex', envKey: 'OPENAI_API_KEY' },
  { client: 'opencode', provider: 'opencode', label: 'OpenCode', cli: 'opencode', envKey: 'ANTHROPIC_API_KEY' },
  { client: 'gemini', provider: 'google', label: 'Gemini', cli: 'gemini', envKey: 'GOOGLE_API_KEY' },
  { client: 'dare', provider: 'dare', label: 'Dare', cli: 'dare', envKey: '' },
  { client: 'kimi', provider: 'kimi', label: 'Kimi', cli: 'kimi', envKey: 'MOONSHOT_API_KEY' },
];

/**
 * Returns true iff the binary exists on PATH. Uses `command -v` via `execFile`
 * (no shell, no agent spawn). Windows falls back to `where`. 1s timeout is
 * orders of magnitude over what a PATH lookup needs but tolerates a slow disk.
 *
 * Exposed as a parameter so tests can substitute a deterministic stub —
 * `detectAvailableClients({ existsOnPath })` in the test boundary.
 */
export type ExistsOnPath = (cli: string) => Promise<boolean>;

const defaultExistsOnPath: ExistsOnPath = async (cli) => {
  // `command -v` is POSIX, returns 0 + path on stdout if found, 1 otherwise.
  // execFile (no shell) prevents argument injection; cli value comes from a
  // closed enum so it's already trusted, but we keep the safe primitive.
  const probeCmd = process.platform === 'win32' ? 'where' : 'command';
  const probeArgs = process.platform === 'win32' ? [cli] : ['-v', cli];
  try {
    if (process.platform === 'win32') {
      await execFileAsync(probeCmd, probeArgs, { timeout: 1000 });
    } else {
      // `command -v` is a shell builtin on POSIX — execFile can't run it directly.
      // Use `/bin/sh -c "command -v <cli>"` with cli passed as positional arg
      // (sh sets $0/$1 from positional args, no interpolation).
      await execFileAsync('/bin/sh', ['-c', 'command -v "$1"', '_probe', cli], { timeout: 1000 });
    }
    return true;
  } catch {
    return false;
  }
};

async function checkCli(spec: CliSpec, existsOnPath: ExistsOnPath): Promise<DetectedClient> {
  // A throwing probe must NOT propagate — one bad CLI shouldn't tank the
  // whole detection. Treat any error as "not installed" (same observable
  // result as a probe that resolved false).
  let installed = false;
  try {
    installed = await existsOnPath(spec.cli);
  } catch {
    installed = false;
  }
  return {
    client: spec.client,
    provider: spec.provider,
    label: spec.label,
    cli: spec.cli,
    installed,
    hasApiKey: spec.envKey ? Boolean(process.env[spec.envKey]) : false,
  };
}

/**
 * Detect all available CLI clients in parallel.
 * Pass a stub `existsOnPath` from tests to avoid touching the real filesystem.
 */
export async function detectAvailableClients(deps?: { existsOnPath?: ExistsOnPath }): Promise<DetectedClient[]> {
  const probe = deps?.existsOnPath ?? defaultExistsOnPath;
  const results = await Promise.all(CLI_SPECS.map((spec) => checkCli(spec, probe)));
  return results;
}

/** Return only clients that are installed. */
export async function getInstalledClients(deps?: { existsOnPath?: ExistsOnPath }): Promise<DetectedClient[]> {
  const all = await detectAvailableClients(deps);
  return all.filter((c) => c.installed);
}

/** Exposed for tests — assert no spec carries a version-fetching command. */
export function getCliSpecsForTest(): readonly CliSpec[] {
  return CLI_SPECS;
}
