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
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_BASENAME = 'compile-system-prompt-l0.mjs';

/**
 * Resolve `scripts/compile-system-prompt-l0.mjs` for monorepo layouts.
 * Mirrors `resolveDefaultClaudeMcpServerPath` (ClaudeAgentService.ts): the API
 * may be started from the repo root or from `packages/api`.
 */
export function resolveL0CompilerScriptPath(cwd: string = process.cwd()): string | undefined {
  const candidates = [
    resolve(cwd, 'scripts', SCRIPT_BASENAME), // cwd = repo root
    resolve(cwd, '../../scripts', SCRIPT_BASENAME), // cwd = packages/api
    resolve(cwd, '../scripts', SCRIPT_BASENAME), // cwd = packages/* (best-effort fallback)
  ];
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

  if (outPath) {
    const content = readFileSync(outPath, 'utf8');
    if (content.trim().length === 0) {
      throw new Error(`L0 compile produced empty file ${outPath} for ${catId}`);
    }
    return content;
  }
  if (stdout.trim().length === 0) {
    throw new Error(`L0 compile produced empty output (no --out) for ${catId}`);
  }
  return stdout;
}
