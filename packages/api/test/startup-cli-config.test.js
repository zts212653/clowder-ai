import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { resolveStartupCliConfigContext } = await import('../dist/config/capabilities/startup-cli-config.js');

describe('resolveStartupCliConfigContext', () => {
  it('uses the monorepo root when the API process cwd is packages/api', async () => {
    const root = join(tmpdir(), `cat-cafe-startup-config-${Date.now()}`);
    const apiCwd = join(root, 'packages', 'api');
    await mkdir(apiCwd, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

    try {
      const context = resolveStartupCliConfigContext(apiCwd);

      assert.equal(context.projectRoot, root);
      assert.equal(context.paths.anthropic, join(root, '.mcp.json'));
      assert.equal(context.paths.openai, join(root, '.codex', 'config.toml'));
      assert.equal(context.paths.google, join(root, '.gemini', 'settings.json'));
      assert.equal(context.paths.kimi, join(root, '.kimi', 'mcp.json'));
      assert.equal(context.paths.antigravity, join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
