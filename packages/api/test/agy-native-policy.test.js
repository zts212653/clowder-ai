import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { buildAgyNativePolicy, preflightAgyNativeWorkspace } = await import(
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
  test('normal work uses native permissions without exact-file or per-tool grants', () => {
    const f = fixture();
    try {
      for (const autoApprove of [false, true]) {
        const policy = buildAgyNativePolicy({ workspaceRoot: f.workspace, autoApprove });
        assert.equal(policy.workspaceRoot, realpathSync(f.workspace));
        assert.equal(policy.settings.enableTerminalSandbox, !autoApprove);
        assert.equal(policy.permissionMode, autoApprove ? 'always-proceed' : 'request-review');
        assert.ok(policy.agentTools.includes('run_command'));
        assert.ok(policy.agentTools.includes('search_web'));
        assert.ok(policy.agentTools.includes('generate_image'));
        assert.ok(policy.settings.permissions.allow.includes('mcp(*)'));
        assert.deepEqual(policy.settings.permissions.deny, []);
      }
      const readOnly = buildAgyNativePolicy({ workspaceRoot: f.workspace, autoApprove: true, readOnly: true });
      assert.equal(readOnly.permissionMode, 'request-review');
      assert.ok(!readOnly.agentTools.includes('run_command'));
      assert.ok(!readOnly.agentTools.includes('write_to_file'));
      assert.ok(readOnly.settings.permissions.deny.includes('mcp(*)'));
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

  test('ordinary workspace files do not prevent normal work', () => {
    const f = fixture();
    try {
      for (const name of ['.env', '.ENV.local', 'package.json', 'pnpm-lock.yaml'])
        writeFileSync(join(f.workspace, name), 'fixture');
      assert.deepEqual(preflightAgyNativeWorkspace(f.workspace), { ok: true });
    } finally {
      f.cleanup();
    }
  });
});
