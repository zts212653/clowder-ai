import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { initGovernanceOverlay, getGovernanceDigest } = await import(
  '../dist/domains/cats/services/context/SystemPromptBuilder.js'
);

async function withTempWorkspace(setupFn, testFn) {
  const tmp = join(tmpdir(), `governance-overlay-test-${Date.now()}`);
  const refsDir = join(tmp, 'cat-cafe-skills', 'refs');
  await mkdir(refsDir, { recursive: true });
  await writeFile(join(tmp, 'pnpm-workspace.yaml'), '');
  if (setupFn) await setupFn(refsDir);

  const savedCwd = process.cwd();
  try {
    process.chdir(tmp);
    await testFn();
  } finally {
    process.chdir(savedCwd);
    await rm(tmp, { recursive: true, force: true });
  }
}

describe('governance overlay integration (#603)', () => {
  it('initGovernanceOverlay uses base when no overlay files exist', async () => {
    await withTempWorkspace(null, async () => {
      await initGovernanceOverlay();
      const digest = getGovernanceDigest();

      assert.ok(digest.includes('家规'), 'base governance digest should be present');
      assert.ok(!digest.includes('Custom rule'), 'no overlay content when files absent');
    });
  });

  it('initGovernanceOverlay appends .local.md content to digest', async () => {
    await withTempWorkspace(
      async (refsDir) => {
        await writeFile(join(refsDir, 'shared-rules.local.md'), '### Fork supplement\nCustom rule here');
      },
      async () => {
        await initGovernanceOverlay();
        const digest = getGovernanceDigest();

        assert.ok(digest.includes('家规'), 'base governance digest should be present');
        assert.ok(digest.includes('Custom rule here'), '.local.md content should be appended');
      },
    );
  });
});
