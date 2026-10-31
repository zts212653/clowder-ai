/**
 * F203 Phase C — fast deterministic L0 compiler stub for carrier unit tests.
 *
 * ClaudeBgCarrierService.startJob now compiles per-cat L0 via a real `node`
 * subprocess (l0-compiler.ts → scripts/compile-system-prompt-l0.mjs). Carrier
 * tests that aren't about L0 inject this stub via the `l0CompilerFn` seam —
 * exactly as they inject `spawnFn` to avoid spawning real `claude` — keeping
 * them fast, deterministic, and decoupled from the compile script / dist.
 *
 * Signature-compatible with `compileL0ViaSubprocess`.
 */

import { writeFileSync } from 'node:fs';

export async function fakeL0Compiler({ catId, outPath }) {
  const body = `# Clowder AI L0 — test stub for ${catId}\n`;
  if (outPath) writeFileSync(outPath, body, 'utf8');
  return body;
}
