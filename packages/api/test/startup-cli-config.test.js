import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const { regenerateStartupCliConfigs, resolveStartupCliConfigContext } = await import(
  '../dist/config/capabilities/startup-cli-config.js'
);
const { withCapabilityLock } = await import('../dist/config/capabilities/capability-orchestrator.js');

describe('resolveStartupCliConfigContext', () => {
  it('uses the monorepo root when the API process cwd is packages/api', async () => {
    const root = join(tmpdir(), `cat-cafe-startup-config-${Date.now()}`);
    const apiCwd = join(root, 'packages', 'api');
    await mkdir(apiCwd, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

    try {
      const context = resolveStartupCliConfigContext(apiCwd);

      assert.equal(context.projectRoot, root);
      assert.equal(context.paths.anthropic, undefined, 'claude uses invoke-time --mcp-config');
      assert.equal(context.paths.openai, undefined, 'codex uses invoke-time --config overrides');
      assert.equal(context.paths.google, join(root, '.gemini', 'settings.json'));
      assert.equal(context.paths.kimi, undefined, 'kimi uses invoke-time temp files');
      assert.equal(context.paths.antigravity, join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses CAT_CAFE_WORKSPACE_ROOT for CLI config targets during runtime-worktree startup', async () => {
    const root = join(tmpdir(), `cat-cafe-startup-config-workspace-${Date.now()}`);
    const runtime = join(tmpdir(), `cat-cafe-startup-config-runtime-${Date.now()}`);
    const apiCwd = join(runtime, 'packages', 'api');
    await mkdir(root, { recursive: true });
    await mkdir(apiCwd, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(join(runtime, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

    try {
      const context = resolveStartupCliConfigContext(apiCwd, { CAT_CAFE_WORKSPACE_ROOT: root });

      assert.equal(context.projectRoot, root);
      assert.equal(context.paths.anthropic, undefined, 'claude uses invoke-time --mcp-config');
      assert.equal(context.paths.openai, undefined, 'codex uses invoke-time --config overrides');
      assert.equal(context.paths.google, join(root, '.gemini', 'settings.json'));
      assert.equal(context.paths.kimi, undefined, 'kimi uses invoke-time temp files');
      assert.equal(context.paths.antigravity, join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  });

  it('regenerates workspace CLI configs with runtime MCP binaries and workspace env', async () => {
    const root = join(tmpdir(), `cat-cafe-startup-regenerate-workspace-${Date.now()}`);
    const runtime = join(tmpdir(), `cat-cafe-startup-regenerate-runtime-${Date.now()}`);
    const apiCwd = join(runtime, 'packages', 'api');
    await mkdir(join(root, '.cat-cafe'), { recursive: true });
    await mkdir(apiCwd, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(join(runtime, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(
      join(root, '.cat-cafe', 'capabilities.json'),
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            id: 'cat-cafe-memory',
            type: 'mcp',
            enabled: true,
            source: 'cat-cafe',
            mcpServer: {
              command: 'node',
              args: ['/old-main/packages/mcp-server/dist/memory.js'],
            },
          },
        ],
      }),
    );

    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const originalRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      delete process.env.ALLOWED_WORKSPACE_DIRS;
      process.env.CAT_CAFE_WORKSPACE_ROOT = root;
      process.env.CAT_CAFE_RUNTIME_ROOT = runtime;

      const result = await regenerateStartupCliConfigs(apiCwd);

      assert.deepEqual(result, { projectRoot: root, generated: true, healed: true });
      const capabilities = JSON.parse(await readFile(join(root, '.cat-cafe', 'capabilities.json'), 'utf-8'));
      assert.equal(
        capabilities.capabilities[0].mcpServer.args[0],
        join(runtime, 'packages', 'mcp-server', 'dist', 'memory.js'),
      );

      // Claude and Codex are invoke-time only — no persistent files should be written.
      // Only Gemini .gemini/settings.json should be generated at startup.
      const gemini = JSON.parse(await readFile(join(root, '.gemini', 'settings.json'), 'utf-8'));
      assert.equal(
        gemini.mcpServers['cat-cafe-memory'].args[0],
        join(runtime, 'packages', 'mcp-server', 'dist', 'memory.js'),
      );
      // Gemini uses callback env placeholders (not ALLOWED_WORKSPACE_DIRS directly)
      assert.ok(gemini.mcpServers['cat-cafe-memory'].env, 'env should be present');
      assert.equal(gemini.mcpServers['cat-cafe-memory'].env.CAT_CAFE_API_URL, '${CAT_CAFE_API_URL}');
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWorkspace === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWorkspace;
      if (originalRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = originalRuntime;
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  });

  it('waits for the capability lock before healing and generating startup configs', async () => {
    const root = join(tmpdir(), `cat-cafe-startup-lock-${Date.now()}`);
    const runtime = join(tmpdir(), `cat-cafe-startup-lock-runtime-${Date.now()}`);
    const apiCwd = join(runtime, 'packages', 'api');
    await mkdir(join(root, '.cat-cafe'), { recursive: true });
    await mkdir(apiCwd, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(join(runtime, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(
      join(root, '.cat-cafe', 'capabilities.json'),
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            id: 'cat-cafe-memory',
            type: 'mcp',
            enabled: true,
            source: 'cat-cafe',
            mcpServer: {
              command: 'node',
              args: ['/old-main/packages/mcp-server/dist/memory.js'],
            },
          },
        ],
      }),
    );

    let releaseLock;
    let enteredLock;
    const enteredPromise = new Promise((resolve) => {
      enteredLock = resolve;
    });
    const releasePromise = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const lockPromise = withCapabilityLock(root, async () => {
      enteredLock();
      await releasePromise;
    });

    const originalWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const originalRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      process.env.CAT_CAFE_WORKSPACE_ROOT = root;
      process.env.CAT_CAFE_RUNTIME_ROOT = runtime;
      await enteredPromise;

      let settled = false;
      const startupPromise = regenerateStartupCliConfigs(apiCwd).then((result) => {
        settled = true;
        return result;
      });

      await sleep(50);
      assert.equal(settled, false, 'startup regeneration must wait for in-flight capability writes');

      releaseLock();
      const result = await startupPromise;
      await lockPromise;
      assert.deepEqual(result, { projectRoot: root, generated: true, healed: true });
    } finally {
      releaseLock?.();
      if (originalWorkspace === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWorkspace;
      if (originalRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = originalRuntime;
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  });
});
