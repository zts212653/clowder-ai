import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { buildAgyNativePolicy } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-policy.js'
);
const { materializeAgyNativeSettings } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-settings.js'
);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-settings-'));
  const home = join(base, 'profile');
  const workspace = join(base, 'workspace');
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  const policy = buildAgyNativePolicy({ workspaceRoot: workspace, writableFiles: ['src/task.ts'], mcpTools: [] });
  const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  return { base, home, workspace, policy, settingsPath, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('F325 isolated native AGY settings', () => {
  test('replaces broad legacy grants with exact task policy and one trusted workspace', () => {
    const f = fixture();
    try {
      writeFileSync(
        f.settingsPath,
        JSON.stringify({
          model: 'old-model',
          trustedWorkspaces: ['/tmp/unrelated'],
          modelProvider: null,
          colorScheme: 'dark',
          toolPermission: 'always-proceed',
          permissions: { allow: ['write_file(/)'] },
        }),
      );
      const path = materializeAgyNativeSettings({
        profileHome: f.home,
        model: 'gemini-3.8-flash-high',
        policy: f.policy,
      });
      assert.equal(path, realpathSync(f.settingsPath));
      const settings = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(settings.model, 'gemini-3.8-flash-high');
      assert.deepEqual(settings.trustedWorkspaces, [f.policy.workspaceRoot]);
      assert.equal(settings.modelProvider, null);
      assert.equal(settings.colorScheme, 'dark');
      assert.deepEqual(settings.permissions, f.policy.settings.permissions);
      assert.equal(settings.toolPermission, 'request-review');
      assert.equal(settings.enableTerminalSandbox, true);
      assert.equal(settings.allowNonWorkspaceAccess, false);
      assert.ok(!readFileSync(path, 'utf8').includes('write_file(/)'));
    } finally {
      f.cleanup();
    }
  });

  test('rejects unknown config and API-key provider without changing settings', () => {
    const f = fixture();
    try {
      for (const existing of [
        { modelProvider: 'gemini' },
        { auth: { type: 'api_key' } },
        { statusLine: { command: 'unsafe' } },
      ]) {
        const before = `${JSON.stringify(existing)}\n`;
        writeFileSync(f.settingsPath, before);
        assert.throws(
          () => materializeAgyNativeSettings({ profileHome: f.home, model: 'gemini-3.8-flash-high', policy: f.policy }),
          /API.key|unknown|unsupported/i,
        );
        assert.equal(readFileSync(f.settingsPath, 'utf8'), before);
      }
    } finally {
      f.cleanup();
    }
  });

  test('refuses real HOME and symlinked settings', () => {
    const f = fixture();
    try {
      assert.throws(
        () =>
          materializeAgyNativeSettings({ profileHome: homedir(), model: 'gemini-3.8-flash-high', policy: f.policy }),
        /real user HOME|isolated/i,
      );
      symlinkSync(join(f.base, 'elsewhere.json'), f.settingsPath);
      assert.throws(
        () => materializeAgyNativeSettings({ profileHome: f.home, model: 'gemini-3.8-flash-high', policy: f.policy }),
        /symlink/i,
      );
    } finally {
      f.cleanup();
    }
  });
});
