import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Existing query doubles still exercise real launch preparation. Declare their
// external executable explicitly, without probing an operator's installation.
export function claudeSdkRuntimeFixture() {
  const path = fileURLToPath(new URL('../fixtures/fake-claude-bg-cli.js', import.meta.url));
  return Object.freeze({
    path,
    executable: process.execPath,
    version: '2.1.312',
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  });
}
