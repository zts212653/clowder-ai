import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { buildAgyNativePolicy, callbackPolicyForAgyNativeMcpTools, preflightAgyNativeWorkspace } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-policy.js'
);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-policy-'));
  const workspace = join(base, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, '.cat-cafe'));
  writeFileSync(join(workspace, 'src', 'existing.ts'), 'export const value = 1;\n');
  return { base, workspace, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('F325 AGY CLI native policy', () => {
  test('gives the agent exact approved file and MCP grants without native shell', () => {
    const f = fixture();
    try {
      const canonicalWorkspace = realpathSync(f.workspace);
      const policy = buildAgyNativePolicy({
        workspaceRoot: f.workspace,
        writableFiles: ['src/existing.ts', 'src/new.ts'],
        mcpTools: ['cat-cafe-collab/cat_cafe_get_thread_context'],
      });

      assert.equal(policy.settings.enableTerminalSandbox, true);
      assert.equal(policy.settings.toolPermission, 'request-review');
      assert.equal(policy.settings.allowNonWorkspaceAccess, false);
      assert.deepEqual(policy.cliArgs, ['--sandbox']);
      assert.deepEqual(policy.settings.permissions.allow, [
        `write_file(${join(canonicalWorkspace, 'src', 'existing.ts')})`,
        `write_file(${join(canonicalWorkspace, 'src', 'new.ts')})`,
        'mcp(cat-cafe-collab/cat_cafe_get_thread_context)',
      ]);
      assert.deepEqual(policy.grantedMcpTools, ['cat-cafe-collab/cat_cafe_get_thread_context']);
      assert.deepEqual(callbackPolicyForAgyNativeMcpTools(policy.grantedMcpTools), {
        mode: 'callback_allowlist',
        allowedCallbackRoutes: ['GET /api/callbacks/thread-context'],
      });
      assert.ok(policy.settings.permissions.deny.includes('command(*)'));
      assert.ok(policy.settings.permissions.deny.includes('unsandboxed(*)'));
      assert.ok(!policy.agentTools.includes('run_command'));
      assert.ok(policy.agentTools.includes('write_to_file'));
      assert.ok(policy.agentTools.includes('replace_file_content'));
    } finally {
      f.cleanup();
    }
  });

  test('rejects directory, outside, executable customization, wildcard MCP, and symlink grants', () => {
    const f = fixture();
    try {
      const outside = join(f.base, 'outside.ts');
      symlinkSync(outside, join(f.workspace, 'src', 'escape.ts'));
      const input = { workspaceRoot: f.workspace, mcpTools: [] };

      for (const path of [
        'src',
        '../outside.ts',
        '.Agents/hooks.json',
        'src/escape.ts',
        'AGENTS.md',
        'src/GEMINI.md',
        'src/*.ts',
        'src/file?.ts',
        'src/[draft].ts',
        'package.json',
        'pnpm-lock.yaml',
        '.npmrc',
        '.gitattributes',
        '.env.local',
        'src/tsconfig.json',
        'src/vitest.config.ts',
        'cat-config.json',
        'cat-template.json',
        '.cat-cafe/cat-catalog.json',
      ]) {
        assert.throws(() => buildAgyNativePolicy({ ...input, writableFiles: [path] }), /unsafe|outside|file|symlink/i);
      }
      assert.throws(
        () => buildAgyNativePolicy({ ...input, writableFiles: [], mcpTools: ['cat-cafe-collab/*'] }),
        /MCP|exact|wildcard/i,
      );
      assert.throws(
        () => buildAgyNativePolicy({ ...input, writableFiles: [], mcpTools: ['untrusted/tool'] }),
        /MCP|trusted/i,
      );
      assert.throws(
        () => buildAgyNativePolicy({ ...input, writableFiles: [], mcpTools: ['cat-cafe-evil/tool'] }),
        /MCP|trusted/i,
      );
      assert.throws(
        () => buildAgyNativePolicy({ ...input, writableFiles: [], mcpTools: ['cat-cafe-collab/cat_cafe_create_task'] }),
        /MCP|trusted|scope/i,
      );
    } finally {
      f.cleanup();
    }
  });

  test('refuses executable workspace customizations before the CLI process starts', () => {
    const f = fixture();
    try {
      assert.deepEqual(preflightAgyNativeWorkspace(f.workspace), { ok: true });
      mkdirSync(join(f.workspace, '.agents', 'rules'), { recursive: true });
      writeFileSync(join(f.workspace, '.agents', 'rules', 'project.md'), 'Project rules\n');
      assert.deepEqual(preflightAgyNativeWorkspace(f.workspace), { ok: true });

      writeFileSync(join(f.workspace, '.agents', 'hooks.json'), '{}');
      assert.deepEqual(preflightAgyNativeWorkspace(f.workspace), {
        ok: false,
        reason: 'workspace_executable_customization',
        path: join(realpathSync(f.workspace), '.agents', 'hooks.json'),
      });
    } finally {
      f.cleanup();
    }
  });

  test('refuses a workspace with a local environment secret file before exposing read tools', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.workspace, '.env.local'), 'TEST_SECRET=fake-sentinel\n');
      assert.deepEqual(preflightAgyNativeWorkspace(f.workspace), {
        ok: false,
        reason: 'workspace_sensitive_content',
        path: join(realpathSync(f.workspace), '.env.local'),
      });
    } finally {
      f.cleanup();
    }
  });

  test('refuses case aliases of workspace executable customizations', () => {
    const f = fixture();
    try {
      mkdirSync(join(f.workspace, '.Agents'));
      writeFileSync(join(f.workspace, '.Agents', 'HOOKS.JSON'), '{}');
      const result = preflightAgyNativeWorkspace(f.workspace);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'workspace_executable_customization');
    } finally {
      f.cleanup();
    }
  });

  test('rejects every executable child alias regardless of node type', () => {
    for (const child of ['HOOKS.JSON', 'AGENTS', 'PLUGINS', 'SKILLS.JSON', 'MCP_CONFIG.JSON']) {
      for (const kind of ['file', 'directory', 'dangling-link']) {
        const f = fixture();
        try {
          const agents = join(f.workspace, '.agents');
          mkdirSync(agents);
          const target = join(agents, child);
          if (kind === 'file') writeFileSync(target, '{}');
          else if (kind === 'directory') mkdirSync(target);
          else symlinkSync(join(f.base, 'missing'), target);
          assert.deepEqual(preflightAgyNativeWorkspace(f.workspace), {
            ok: false,
            reason: 'workspace_executable_customization',
            path: join(realpathSync(agents), child),
          });
        } finally {
          f.cleanup();
        }
      }
    }
  });

  test('examines every agents directory alias, including symlink aliases', () => {
    for (const symlink of [false, true]) {
      const f = fixture();
      try {
        mkdirSync(join(f.workspace, '.agents'));
        // Two distinct aliases can coexist only on a case-sensitive filesystem.
        if (existsSync(join(f.workspace, '.Agents'))) rmSync(join(f.workspace, '.agents'), { recursive: true });
        if (symlink) symlinkSync(join(f.base, 'missing'), join(f.workspace, '.Agents'));
        else {
          mkdirSync(join(f.workspace, '.Agents'));
          writeFileSync(join(f.workspace, '.Agents', 'MCP_CONFIG.JSON'), '{}');
        }
        const result = preflightAgyNativeWorkspace(f.workspace);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'workspace_executable_customization');
      } finally {
        f.cleanup();
      }
    }
  });

  test('refuses sensitive filename aliases while accepting example env templates', () => {
    for (const name of ['.ENV.local', '.NETRC', '.PYPIRC', '.SSH', '.AWS']) {
      const f = fixture();
      try {
        writeFileSync(join(f.workspace, name), 'fake-sentinel');
        const result = preflightAgyNativeWorkspace(f.workspace);
        assert.equal(result.ok, false, name);
        assert.equal(result.reason, 'workspace_sensitive_content');
      } finally {
        f.cleanup();
      }
    }
    const f = fixture();
    try {
      for (const name of ['.env.example', '.env.local.example', '.env.example.opensource']) {
        writeFileSync(join(f.workspace, name), 'EXAMPLE=placeholder');
      }
      assert.deepEqual(preflightAgyNativeWorkspace(f.workspace), { ok: true });
    } finally {
      f.cleanup();
    }
  });
});
