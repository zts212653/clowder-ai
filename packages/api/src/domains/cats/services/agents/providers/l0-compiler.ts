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
import { CURRENT_RELATIONSHIP_PROFILE_URI, DEFAULT_PROFILE_USER_ID } from '@cat-cafe/shared/profile-contract';
import { profilePointerEmitted } from '../../../../../infrastructure/telemetry/instruments.js';
import { FileProfileRepository } from '../../profile/ProfileRepository.js';
import { L0DependencySignatureTracker } from './l0-dependency-signature.js';
import { type L0CacheGeneration, L0ProfileCache } from './l0-profile-cache.js';

const SCRIPT_BASENAME = 'compile-system-prompt-l0.mjs';
const l0Cache = new L0ProfileCache();
const dependencySignatures = new L0DependencySignatureTracker();

function recordProfilePointerEmission(compiledL0: string): void {
  if (compiledL0.includes(CURRENT_RELATIONSHIP_PROFILE_URI)) profilePointerEmitted.add(1);
}

function refreshL0DependencySignature(cwd: string, scriptPath: string): string | null {
  return dependencySignatures.refresh(cwd, scriptPath, () => l0Cache.clear());
}

/** Clear cached L0 for one cat or all cats (call on hot-reload / re-sync). */
export function clearL0Cache(catId?: string, userId?: string): void {
  l0Cache.clear(catId, userId);
}

/** Number of cached entries (test/diagnostic). */
export function l0CacheSize(): number {
  return l0Cache.size();
}

/**
 * Pre-compile L0 for a list of catIds in parallel at startup.
 * Failures are logged but don't block startup — invoke() will retry.
 */
export async function warmL0Cache(
  catIds: string[],
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  userId: string = process.env.CAT_CAFE_USER_ID ?? DEFAULT_PROFILE_USER_ID,
): Promise<void> {
  await Promise.all(
    catIds.map((catId) =>
      compileL0ViaSubprocess({ catId, userId }).catch((err: unknown) => {
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
  /** User whose private profile is compiled. Defaults to CAT_CAFE_USER_ID/default-user. */
  userId?: string;
  /** Canonical data root test/config seam. Defaults to CAT_CAFE_DATA_DIR/~/.cat-cafe. */
  dataDir?: string;
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
  const { catId, outPath } = options;
  const userId = options.userId ?? process.env.CAT_CAFE_USER_ID ?? DEFAULT_PROFILE_USER_ID;
  const key = l0Cache.key(userId, catId);
  const cwd = options.cwd ?? process.cwd();
  const scriptPath = resolveL0CompilerScriptPath(cwd);
  const dependencySignature = scriptPath ? refreshL0DependencySignature(cwd, scriptPath) : null;
  const profileDir = new FileProfileRepository({ dataDir: options.dataDir }).profileDir(userId);
  const profileSignature = l0Cache.refreshProfileSignature(key, profileDir);

  // Cache hit — skip subprocess entirely
  const cached = dependencySignature && profileSignature !== null ? l0Cache.get(key) : undefined;
  if (cached) {
    if (outPath) writeFileSync(outPath, cached, 'utf8');
    recordProfilePointerEmission(cached);
    return cached;
  }

  // In-flight dedup — collapse concurrent cold-cache callers onto a single
  // subprocess. The first caller installs the Promise; subsequent callers
  // await the same one. Per-call `outPath` is honored: any caller that
  // passed `outPath` writes the resolved L0 to that path before returning.
  // Phase G AC-G10 — the profile cache owns the shared in-flight promise.
  const inflight = dependencySignature && profileSignature !== null ? l0Cache.getInflight(key) : undefined;
  if (inflight) {
    const result = await inflight;
    if (outPath) writeFileSync(outPath, result, 'utf8');
    recordProfilePointerEmission(result);
    return result;
  }

  const compileGeneration = l0Cache.generation(key);
  const compilePromise = doCompileL0(
    { ...options, userId },
    key,
    compileGeneration,
    dependencySignature,
    profileSignature,
    profileDir,
  );
  l0Cache.setInflight(key, compilePromise);
  try {
    const result = await compilePromise;
    recordProfilePointerEmission(result);
    return result;
  } finally {
    // Always clean up the in-flight entry once settled — subsequent calls
    // will read from l0Cache (on success) or re-attempt (on failure).
    l0Cache.deleteInflight(key, compilePromise);
  }
}

/**
 * Internal compile path — separated from `compileL0ViaSubprocess` so the
 * in-flight dedup wrapper can install the Promise without recursing.
 */
async function doCompileL0(
  options: CompileL0Options,
  cacheKey: string,
  compileGeneration: L0CacheGeneration,
  dependencySignature: string | null,
  profileSignature: string | null,
  profileDir: string,
): Promise<string> {
  const { catId, outPath, cwd = process.cwd(), spawnFn = nodeSpawn } = options;
  const scriptPath = resolveL0CompilerScriptPath(cwd);
  if (!scriptPath) {
    throw new Error(
      `L0 compiler script not resolvable from cwd=${cwd} (expected scripts/${SCRIPT_BASENAME}); cannot compile L0 for ${catId}`,
    );
  }

  // F231 KD-19: private profile truth is user-scoped persistent data, never cwd/worktree state.
  const args = [scriptPath, '--cat', catId, '--profile-dir', profileDir, ...(outPath ? ['--out', outPath] : [])];

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

  if (
    dependencySignature &&
    profileSignature !== null &&
    dependencySignatures.isCurrent(dependencySignature) &&
    l0Cache.profileSignatureIsCurrent(profileDir, profileSignature) &&
    l0Cache.generationIsCurrent(cacheKey, compileGeneration)
  ) {
    l0Cache.set(cacheKey, result, profileSignature);
  }
  return result;
}
