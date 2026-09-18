/**
 * Fast deterministic session-prompt fixture for carrier unit tests.
 *
 * Production carriers receive route-owned HookPipeline bytes. Older carrier
 * tests use the legacy-named constructor seam to avoid constructing a route;
 * the fixture writes the same transport file shape and never invokes a second
 * prompt builder.
 */

import { writeFileSync } from 'node:fs';

export async function fakeL0Compiler({ catId, outPath }) {
  const body = `# Clowder AI session hooks — test fixture for ${catId}\n`;
  if (outPath) writeFileSync(outPath, body, 'utf8');
  return body;
}
