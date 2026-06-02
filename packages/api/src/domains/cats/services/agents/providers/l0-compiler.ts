/**
 * F203 Phase C — shared L0 compile boundary (Task 3a).
 *
 * The API build artefact CANNOT in-process import
 * `scripts/compile-system-prompt-l0.mjs`: that .mjs hardcodes
 * `await import('../packages/api/dist/...')` relative to itself, so importing
 * it back into the compiled API package would couple the built package to an
 * out-of-package script, require dist to be built, and double-bootstrap
 * catRegistry inside the API process. Instead we cross the boundary via a
 * subprocess to the Phase B CLI (KD-10: `writeL0File()` + `--out`).
 *
 * Single source of truth for that boundary — both ClaudeBgCarrierService
 * (`--system-prompt-file`) and CodexAgentService (`-c developer_instructions`)
 * consume it.
 *
 * fail-closed by design: any failure throws. In the terminal Phase C state the
 * user message no longer carries the non-pack identity/家规 (stripped in
 * Task 2), so a missing L0 = a cat with no identity/governance — strictly worse
 * than a failed invocation (which retries / surfaces loudly). Aligns with the
 * iron-rule philosophy and KD-5 (no feature flag, git-revert rollback).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_BASENAME = 'compile-system-prompt-l0.mjs';

// ── L0 cache ────────────────────────────────────────────────────────
// The compiled L0 depends on static inputs (shared-rules.md, cat config,
// teammate roster) that don't change during a session. Caching avoids
// spawning a subprocess on every invoke(). The cache is populated at
// startup via warmL0Cache() and invalidated on hot-reload via clearL0Cache().
const l0Cache = new Map<string, string>();

/** Clear cached L0 for one cat or all cats (call on hot-reload / re-sync). */
export function clearL0Cache(catId?: string): void {
  if (catId) l0Cache.delete(catId);
  else l0Cache.clear();
}

/** Number of cached entries (test/diagnostic). */
export function l0CacheSize(): number {
  return l0Cache.size;
}

/**
 * Pre-compile L0 for a list of catIds in parallel at startup.
 * Failures are logged but don't block startup — invoke() will retry.
 */
export async function warmL0Cache(
  catIds: string[],
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<void> {
  await Promise.all(
    catIds.map((catId) =>
      compileL0ViaSubprocess({ catId }).catch((err: unknown) => {
        logger?.warn({ catId, err: (err as Error).message }, 'L0 pre-compile failed at startup (will retry on invoke)');
      }),
    ),
  );
}

/**
 * Derive the install root from this module's file path.
 * l0-compiler.ts lives at packages/api/src/domains/cats/services/agents/providers/
 * → dist layout: packages/api/dist/domains/cats/services/agents/providers/l0-compiler.js
 * → 8 levels up from dirname(__filename) reaches the install root.
 * Used as fallback when cwd-based resolution fails (e.g. Windows NTFS junctions
 * not yet traversable on first boot after installation).
 */
function deriveInstallRoot(): string | undefined {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return resolve(dirname(thisFile), '..', '..', '..', '..', '..', '..', '..', '..');
  } catch {
    return undefined;
  }
}

/**
 * Resolve `scripts/compile-system-prompt-l0.mjs` for monorepo layouts.
 * Mirrors `resolveDefaultClaudeMcpServerPath` (ClaudeAgentService.ts): the API
 * may be started from the repo root or from `packages/api`.
 *
 * Falls back to the install root (derived from this module's file path) when
 * cwd-based candidates all fail — this covers Windows packaged installs where
 * the API's cwd is a user-data mirror directory whose NTFS junctions to the
 * install root may not yet be traversable on first boot (#802).
 */
export function resolveL0CompilerScriptPath(cwd: string = process.cwd()): string | undefined {
  const candidates = [
    resolve(cwd, 'scripts', SCRIPT_BASENAME), // cwd = repo root
    resolve(cwd, '../../scripts', SCRIPT_BASENAME), // cwd = packages/api
    resolve(cwd, '../scripts', SCRIPT_BASENAME), // cwd = packages/* (best-effort fallback)
  ];

  // Install-root fallback: bypass junction on Windows first-boot (#802)
  const installRoot = deriveInstallRoot();
  if (installRoot) {
    candidates.push(resolve(installRoot, 'scripts', SCRIPT_BASENAME));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface CompileL0Options {
  /** Cat to compile L0 for (must be registered in the runtime cat catalog). */
  catId: string;
  /**
   * When set → the script writes the compiled L0 to this path (Claude
   * `--system-prompt-file`). When omitted → the compiled L0 is captured from
   * stdout and returned (Codex `-c developer_instructions=`).
   */
  outPath?: string;
  /** Working dir used to resolve the script + spawn (defaults to process.cwd()). */
  cwd?: string;
  /** Test seam — replaces the real spawn. */
  spawnFn?: typeof nodeSpawn;
}

/**
 * Compile per-cat L0 by invoking the Phase B CLI as a subprocess.
 * @returns the compiled L0 string (file content when `outPath` is set, else stdout).
 * @throws when the script is unresolvable, the subprocess fails to spawn,
 *   exits non-zero, or produces empty output (fail-closed).
 */
export async function compileL0ViaSubprocess(options: CompileL0Options): Promise<string> {
  const { catId, outPath, cwd = process.cwd(), spawnFn = nodeSpawn } = options;

  // Cache hit — skip subprocess entirely
  const cached = l0Cache.get(catId);
  if (cached) {
    if (outPath) writeFileSync(outPath, cached, 'utf8');
    return cached;
  }

  const scriptPath = resolveL0CompilerScriptPath(cwd);
  if (!scriptPath) {
    throw new Error(
      `L0 compiler script not resolvable from cwd=${cwd} (expected scripts/${SCRIPT_BASENAME}); cannot compile L0 for ${catId}`,
    );
  }

  const args = [scriptPath, '--cat', catId, ...(outPath ? ['--out', outPath] : [])];

  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawnFn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e: Error) => fail(new Error(`L0 compile spawn failed for ${catId}: ${e.message}`)));
    child.on('close', (code: number | null) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`L0 compile exited code=${code} for ${catId}: ${err.trim() || '(no stderr)'}`));
        return;
      }
      settled = true;
      resolvePromise(out);
    });
  });

  let result: string;
  if (outPath) {
    result = readFileSync(outPath, 'utf8');
    if (result.trim().length === 0) {
      throw new Error(`L0 compile produced empty file ${outPath} for ${catId}`);
    }
  } else {
    result = stdout;
    if (result.trim().length === 0) {
      throw new Error(`L0 compile produced empty output (no --out) for ${catId}`);
    }
  }

  l0Cache.set(catId, result);
  return result;
}
