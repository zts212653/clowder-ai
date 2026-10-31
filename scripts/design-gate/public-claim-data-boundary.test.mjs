import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

it('replays the portable claim suites without Clowder AI home claim data', () => {
  const publicDataRoot = mkdtempSync(join(tmpdir(), 'design-gate-public-claims-'));
  try {
    const environment = {
      ...process.env,
      DESIGN_GATE_TEST_REPO_ROOT: publicDataRoot,
    };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        resolve(repoRoot, 'scripts/design-gate/claim-contract.test.mjs'),
        resolve(repoRoot, 'scripts/design-gate/claim-journey-paths.test.mjs'),
      ],
      { cwd: repoRoot, encoding: 'utf8', env: environment },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(publicDataRoot, { recursive: true, force: true });
  }
});
