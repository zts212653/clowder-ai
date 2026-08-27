import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClaimDirectory } from './design-gate-real-interaction.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = checkClaimDirectory({ repoRoot });

if (!result.ok) {
  console.error('FAIL design-gate-real-interaction');
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS design-gate-real-interaction: committed_claims=${result.checked}`);
}
