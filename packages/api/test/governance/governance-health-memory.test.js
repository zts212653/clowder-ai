import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GOVERNANCE_PACK_VERSION } from '../../dist/config/governance/governance-pack.js';

test('1001-project health fits a 64 MiB process with exactly one disk read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gov-health-memory-'));
  try {
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      packVersion: index % 2 ? 'old' : GOVERNANCE_PACK_VERSION,
      checksum: 'isolated-metadata',
      syncedAt: 1791497228000 + index,
      confirmedByUser: true,
      projectPath: `/private/var/folders/synthetic-${index}/setup-fixture-${'x'.repeat(42)}/project`,
    }));
    await mkdir(join(root, '.cat-cafe'));
    await writeFile(join(root, '.cat-cafe/governance-registry.json'), JSON.stringify({ entries }, null, 2));
    const child = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=64',
        fileURLToPath(new URL('../helpers/governance-health-memory-probe.mjs', import.meta.url)),
        root,
      ],
      { timeout: 10_000, maxBuffer: 16_384, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.results, 1001);
    assert.equal(result.reads, 1);
    assert.ok(result.bytes < 300_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
